// Bobcat Bites — Stripe Connect edge function
//
// Deploy separately from the existing `api` function (this never touches it):
//   supabase functions deploy stripe --no-verify-jwt
// (--no-verify-jwt is required: Stripe's webhook calls carry no Supabase JWT.
//  Every route below does its own auth — webhook via signature, vendor routes
//  via the caller's user JWT, checkout via server-side validation.)
//
// Required secrets (Dashboard → Edge Functions → Secrets):
//   STRIPE_SECRET_KEY       sk_test_... to start, sk_live_... when ready
//   STRIPE_WEBHOOK_SECRET   whsec_... from the webhook endpoint you create at
//                           https://dashboard.stripe.com/webhooks pointing to
//                           https://<project>.supabase.co/functions/v1/stripe/webhook
//                           (events: checkout.session.completed, checkout.session.expired)
// Optional:
//   PLATFORM_FEE_BPS         basis points taken per order (default 700 = 7%)
//   PLATFORM_FEE_FIXED_CENTS flat cents added on top (default 0)
//   APP_URL                  where students return after paying
//                            (default https://questluvv.github.io/Bobcat-Bites)

import { createClient } from "jsr:@supabase/supabase-js@2";

const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
const FEE_BPS = parseInt(Deno.env.get("PLATFORM_FEE_BPS") ?? "700", 10);
const FEE_FIXED = parseInt(Deno.env.get("PLATFORM_FEE_FIXED_CENTS") ?? "0", 10);
const APP_URL = Deno.env.get("APP_URL") ?? "https://questluvv.github.io/Bobcat-Bites";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ---- tiny Stripe client (form-encoded fetch; no SDK dependency) ----
function form(params: Record<string, unknown>, prefix = "", out = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) =>
        typeof item === "object" ? form(item as Record<string, unknown>, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(item)));
    } else if (typeof v === "object") {
      form(v as Record<string, unknown>, key, out);
    } else out.append(key, String(v));
  }
  return out;
}
async function stripe(path: string, params?: Record<string, unknown>, method = "POST") {
  const res = await fetch("https://api.stripe.com/v1/" + path, {
    method,
    headers: { Authorization: "Bearer " + STRIPE_KEY, "Content-Type": "application/x-www-form-urlencoded" },
    body: method === "GET" ? undefined : form(params ?? {}),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message || "Stripe error");
  return body;
}

async function verifyStripeSig(payload: string, header: string | null): Promise<boolean> {
  if (!header || !WEBHOOK_SECRET) return false;
  const parts = new Map(header.split(",").map((p) => p.split("=", 2) as [string, string]));
  const t = parts.get("t"), v1 = parts.get("v1");
  if (!t || !v1) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === v1;
}

// Insert tolerating columns that may not exist yet in this schema — retries
// without the optional ones so the scaffold works before any orders-table tweaks.
async function insertRow(table: string, row: Record<string, unknown>, optional: string[]) {
  let attempt = { ...row };
  for (let i = 0; i <= optional.length; i++) {
    const { data, error } = await admin.from(table).insert(attempt).select().maybeSingle();
    if (!error) return data;
    const missing = optional.find((c) => c in attempt && error.message.includes(c));
    if (!missing) throw new Error(error.message);
    delete attempt[missing];
  }
  throw new Error("insert failed");
}

async function userFromReq(req: Request) {
  const auth = req.headers.get("Authorization") ?? "";
  const anon = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
  });
  const { data: { user } } = await anon.auth.getUser();
  return user;
}

async function vendorForUser(userId: string) {
  const { data } = await admin.from("vendors").select("*").eq("owner_user_id", userId).maybeSingle();
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);

  // ---- Stripe webhook (auth = signature, not JWT) ----
  if (url.pathname.endsWith("/webhook")) {
    const payload = await req.text();
    if (!(await verifyStripeSig(payload, req.headers.get("stripe-signature")))) {
      return json({ error: "bad signature" }, 400);
    }
    const event = JSON.parse(payload);
    const session = event.data?.object;
    const orderId = session?.metadata?.order_id;
    if (orderId && event.type === "checkout.session.completed") {
      const patch: Record<string, unknown> = { status: "placed", updated_at: new Date().toISOString() };
      let { error } = await admin.from("orders").update({ ...patch, payment_intent_id: session.payment_intent }).eq("id", orderId);
      if (error) ({ error } = await admin.from("orders").update(patch).eq("id", orderId));
      if (!error) await admin.from("order_status_events").insert({ order_id: orderId, status: "placed", note: "paid via Stripe" });
    }
    if (orderId && event.type === "checkout.session.expired") {
      await admin.from("orders").update({ status: "cancelled", cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", orderId).eq("status", "pending_payment");
    }
    return json({ received: true });
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const action = body.action as string;

  try {
    // ---- feature probe: lets the frontend fail closed to demo pay ----
    if (action === "status") return json({ enabled: !!STRIPE_KEY });
    if (!STRIPE_KEY) return json({ error: "Card payments aren't set up yet" }, 400);

    // ---- vendor: create/resume Stripe Express onboarding ----
    if (action === "vendor_onboard") {
      const user = await userFromReq(req);
      if (!user) return json({ error: "Log in first" }, 401);
      const vendor = await vendorForUser(user.id);
      if (!vendor) return json({ error: "No truck registered" }, 400);
      let acct = vendor.payout_account_id;
      if (!acct) {
        const account = await stripe("accounts", {
          type: "express",
          email: vendor.contact_email ?? user.email,
          capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
          business_profile: { name: vendor.name },
        });
        acct = account.id;
        const { error } = await admin.from("vendors").update({ payout_account_id: acct, updated_at: new Date().toISOString() }).eq("id", vendor.id);
        if (error) throw new Error("Couldn't save payout account: " + error.message);
      }
      const link = await stripe("account_links", {
        account: acct,
        type: "account_onboarding",
        refresh_url: APP_URL + "/vendor_app.html",
        return_url: APP_URL + "/vendor_app.html",
      });
      return json({ url: link.url });
    }

    // ---- vendor: payout status for the My Truck card ----
    if (action === "vendor_payout_status") {
      const user = await userFromReq(req);
      if (!user) return json({ error: "Log in first" }, 401);
      const vendor = await vendorForUser(user.id);
      if (!vendor?.payout_account_id) return json({ connected: false });
      const account = await stripe("accounts/" + vendor.payout_account_id, undefined, "GET");
      return json({ connected: true, charges_enabled: account.charges_enabled, details_submitted: account.details_submitted, payouts_enabled: account.payouts_enabled });
    }

    // ---- student: paid checkout (replaces demo pay when active) ----
    if (action === "create_checkout") {
      const { device_key, student_name, phone, vendor_id, items } = body as {
        device_key: string; student_name: string; phone?: string; vendor_id: string;
        items: { menu_item_id: string; quantity: number }[];
      };
      if (!device_key || !student_name?.trim() || !vendor_id || !items?.length) return json({ error: "Missing order details" }, 400);

      const { data: vendor } = await admin.from("vendors").select("*").eq("id", vendor_id).maybeSingle();
      if (!vendor || vendor.status !== "approved") return json({ error: "Truck not available" }, 400);
      if (!vendor.is_open || vendor.orders_paused) return json({ error: "This truck isn't accepting orders right now" }, 400);
      if (!vendor.payout_account_id) return json({ error: "This truck isn't set up for card payments yet", code: "no_card_payments" }, 400);

      const ids = items.map((i) => i.menu_item_id);
      const { data: menu } = await admin.from("menu_items").select("*").eq("vendor_id", vendor_id).eq("is_available", true).in("id", ids);
      if (!menu || menu.length !== new Set(ids).size) return json({ error: "Some items are no longer available" }, 400);

      let total = 0;
      const lines = items.map((i) => {
        const m = menu.find((x) => x.id === i.menu_item_id)!;
        const qty = Math.max(1, Math.min(20, Math.floor(i.quantity)));
        total += m.price_cents * qty;
        return { m, qty };
      });

      let { data: student } = await admin.from("students").select("*").eq("device_key", device_key).maybeSingle();
      if (!student) {
        student = await insertRow("students", { device_key, full_name: student_name.trim(), phone: phone?.trim() || null }, ["phone"]);
      } else {
        await admin.from("students").update({ full_name: student_name.trim(), phone: phone?.trim() || student.phone }).eq("id", student.id);
      }

      const pickup_code = String(Math.floor(1000 + Math.random() * 9000));
      const order = await insertRow("orders", {
        student_id: student.id, vendor_id, status: "pending_payment", pickup_code,
        total_cents: total, subtotal_cents: total,
      }, ["subtotal_cents"]);
      for (const { m, qty } of lines) {
        await insertRow("order_items", {
          order_id: order.id, menu_item_id: m.id, item_name_snapshot: m.name,
          unit_price_cents: m.price_cents, quantity: qty,
        }, ["menu_item_id"]);
      }

      const fee = Math.min(total, Math.round((total * FEE_BPS) / 10000) + FEE_FIXED);
      const session = await stripe("checkout/sessions", {
        mode: "payment",
        line_items: lines.map(({ m, qty }) => ({
          quantity: qty,
          price_data: { currency: "usd", unit_amount: m.price_cents, product_data: { name: m.name } },
        })),
        payment_intent_data: { application_fee_amount: fee, transfer_data: { destination: vendor.payout_account_id } },
        metadata: { order_id: order.id },
        success_url: APP_URL + "/index.html?paid=1",
        cancel_url: APP_URL + "/index.html?pay_cancelled=1",
        expires_at: Math.floor(Date.now() / 1000) + 1800,
      });
      return json({ url: session.url, order_id: order.id, pickup_code });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});
