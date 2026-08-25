// Bobcat Bites — Stripe Connect edge function
//
// Required secrets (Dashboard → Edge Functions → Secrets):
//   STRIPE_SECRET_KEY       sk_test_... to start, sk_live_... when ready
//   STRIPE_WEBHOOK_SECRET   whsec_... from the webhook endpoint pointing to
//                           https://<project>.supabase.co/functions/v1/stripe/webhook
//                           (events: checkout.session.completed, checkout.session.expired)
//   NOTE: webhook endpoints are PER MODE. A live-mode endpoint receives nothing
//   while the key is sk_test_ — create a test-mode endpoint and use ITS whsec_.
// Optional:
//   PLATFORM_FEE_BPS         basis points taken per order (default 700 = 7%)
//   PLATFORM_FEE_FIXED_CENTS flat cents added on top (default 0)
//   APP_URL                  live origin students return to. NO trailing slash.
//
// ORDER LIFECYCLE (why 'pending_payment' exists):
//   create_checkout inserts the order as 'pending_payment'. The vendor app only
//   queries placed/confirmed/ready, and the DB trigger only pushes the "new
//   order" alert on entry to 'placed'. So the truck learns about an order when
//   Stripe confirms payment — never when the student merely taps Pay and then
//   abandons checkout, which previously had vendors cooking unpaid food.

import { createClient } from "jsr:@supabase/supabase-js@2";

const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
const FEE_BPS = parseInt(Deno.env.get("PLATFORM_FEE_BPS") ?? "700", 10);
const FEE_FIXED = parseInt(Deno.env.get("PLATFORM_FEE_FIXED_CENTS") ?? "0", 10);
// The fallback is where students are returned after paying. It used to name the
// GitHub Pages mirror, which is now retired — if APP_URL were ever unset, every
// payer would have been handed back to a dead host holding a live order.
const APP_URL = (Deno.env.get("APP_URL") ?? "https://bobcat-bites.com").replace(/\/+$/, "");

function computePlatformFeeCents(totalCents: number): { fee: number; safeBps: number; safeFixed: number } {
  const safeBps = Number.isFinite(FEE_BPS) && FEE_BPS > 0 && FEE_BPS <= 10000 ? FEE_BPS : 700;
  const safeFixed = Number.isFinite(FEE_FIXED) && FEE_FIXED >= 0 ? FEE_FIXED : 0;
  const raw = Math.round((totalCents * safeBps) / 10000) + safeFixed;
  const fee = Math.max(0, Math.min(totalCents, raw)); // clamp to [0, total]
  return { fee, safeBps, safeFixed };
}

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Pinned to the production origins. Defence in depth, not a boundary: CORS
// constrains browsers, not curl, so it never stands in for the auth checks below.
const ALLOWED_ORIGINS = new Set([
  "https://bobcat-bites.com",
  "https://www.bobcat-bites.com",
  // The Workers subdomain still serves the same app. Drop once it is retired.
  "https://bobcat-bites.questchester05.workers.dev",
]);
function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://bobcat-bites.com",
    // Without Vary, a cache could hand one origin's response to another.
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  };
}

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
async function stripe(path: string, params?: Record<string, unknown>, method = "POST", idempotencyKey?: string) {
  const headers: Record<string, string> = {
    Authorization: "Bearer " + STRIPE_KEY,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  // Stripe replays the original response for a repeated key rather than acting
  // twice — the difference between a double-tapped Decline and a double refund.
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch("https://api.stripe.com/v1/" + path, {
    method,
    headers,
    body: method === "GET" ? undefined : form(params ?? {}),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message || "Stripe error");
  return body;
}

async function verifyStripeSig(payload: string, header: string | null, toleranceSec = 300): Promise<boolean> {
  if (!header || !WEBHOOK_SECRET) return false;
  const parts = new Map(header.split(",").map((p) => p.split("=", 2) as [string, string]));
  const t = parts.get("t"), v1 = parts.get("v1");
  if (!t || !v1) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - parseInt(t, 10)) > toleranceSec) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

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
  // Per request so the echoed origin matches the caller; a module-level object
  // would be shared across concurrent requests.
  const CORS = corsFor(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);

  // ---- Stripe webhook (auth = signature, not JWT) ----
  if (url.pathname.endsWith("/webhook")) {
    const payload = await req.text();
    const sigOk = await verifyStripeSig(payload, req.headers.get("stripe-signature"));
    if (!sigOk) {
      // Logged loudly: a wrong/missing STRIPE_WEBHOOK_SECRET looks identical to
      // "Stripe never called" from the database side, and that ambiguity is
      // expensive to debug. This line disambiguates the two.
      console.error("[webhook] signature verification FAILED — check STRIPE_WEBHOOK_SECRET matches this endpoint's signing secret, and that the endpoint is in the same mode (test/live) as STRIPE_SECRET_KEY");
      return json({ error: "bad signature" }, 400);
    }
    const event = JSON.parse(payload);
    const session = event.data?.object;
    const orderId = session?.metadata?.order_id;
    console.log("[webhook] received", event.type, "order", orderId ?? "(none)");

    if (orderId && event.type === "checkout.session.completed") {
      // Promote to 'placed' — this is what fires the vendor's new-order push,
      // via the DB trigger. Payment confirmed is the ONLY path to the kitchen.
      //
      // Guarded on 'pending_payment' because Stripe retries an endpoint until
      // it gets a 2xx and can deliver the same event more than once. Ungated,
      // a redelivery landing after the truck had already confirmed would rewind
      // the order to 'placed' and fire notify_new_order again — a brand new
      // ticket for food that was already made. The 'expired' handler below has
      // always been guarded this way; this one was not.
      const now = new Date().toISOString();
      const guard = (q: any) => q.eq("id", orderId).eq("status", "pending_payment").select("id");
      let { data, error } = await guard(
        admin.from("orders").update({ status: "placed", updated_at: now, payment_intent_id: session.payment_intent }),
      );

      // Retry WITHOUT the payment reference only when that column is what the
      // database complained about. The old code dropped it on any error, so a
      // single transient failure silently discarded the one value a refund
      // needs — leaving a paid order that can never be refunded automatically.
      if (error && /payment_intent_id/i.test(error.message)) {
        ({ data, error } = await guard(admin.from("orders").update({ status: "placed", updated_at: now })));
      }

      if (error) {
        console.error("[webhook] failed to mark order paid:", orderId, error.message);
      } else if (!data?.length) {
        // Nothing moved: an earlier delivery already promoted this order. Do
        // not write a second status event and do not push again. Do still make
        // sure the payment reference landed, in case the delivery that promoted
        // it fell back to the reduced write above.
        if (session.payment_intent) {
          await admin.from("orders")
            .update({ payment_intent_id: session.payment_intent })
            .eq("id", orderId).is("payment_intent_id", null);
        }
        console.log("[webhook] order", orderId, "was already paid — ignoring repeat delivery");
      } else {
        await admin.from("order_status_events").insert({ order_id: orderId, status: "placed", note: "paid via Stripe" });
        console.log("[webhook] order", orderId, "marked paid");
      }
    }

    if (orderId && event.type === "checkout.session.expired") {
      // Only abandon orders still awaiting payment — never touch one the vendor
      // is already working on.
      await admin.from("orders")
        .update({ status: "cancelled", cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", orderId).eq("status", "pending_payment");
    }
    return json({ received: true });
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const action = body.action as string;

  try {
    // key_mode is the sk_ prefix, nothing more — no part of the secret is
    // exposed. It exists because the go-live swap has to move STRIPE_SECRET_KEY
    // and STRIPE_WEBHOOK_SECRET together: a live key with a test endpoint's
    // whsec_ takes the student's money and never promotes the order out of
    // 'pending_payment', so the truck never sees the ticket. Without this you
    // only learn which mode you are in by losing a real order. Read it right
    // after the swap — it must say "live" before a real card is used.
    if (action === "status") {
      return json({
        enabled: !!STRIPE_KEY,
        app_url: APP_URL,
        webhook_secret_set: !!WEBHOOK_SECRET,
        key_mode: STRIPE_KEY.startsWith("sk_live_") ? "live"
                : STRIPE_KEY.startsWith("sk_test_") ? "test"
                : STRIPE_KEY ? "unknown" : null,
      });
    }
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
      return json({
        connected: true,
        charges_enabled: account.charges_enabled,
        details_submitted: account.details_submitted,
        payouts_enabled: account.payouts_enabled,
        transfers: account.capabilities?.transfers ?? "unknown",
        requirements_due: account.requirements?.currently_due ?? [],
      });
    }

    // ---- vendor: decline/cancel a paid order, refunding the student ----
    // refunds.html promises "a full refund automatically when the truck declines
    // or cancels your order", so cancelling and refunding have to be one
    // operation. The vendor app routes its Decline/Cancel button here rather
    // than writing status='cancelled' straight to the table, which would take
    // the student's money and give nothing back.
    if (action === "cancel_order") {
      const user = await userFromReq(req);
      if (!user) return json({ error: "Log in first" }, 401);
      const vendor = await vendorForUser(user.id);
      if (!vendor) return json({ error: "No truck registered" }, 400);
      const orderId = body.order_id as string;
      if (!orderId) return json({ error: "Missing order_id" }, 400);

      const { data: order } = await admin.from("orders").select("*").eq("id", orderId).maybeSingle();
      if (!order) return json({ error: "Order not found" }, 404);
      if (order.vendor_id !== vendor.id) return json({ error: "Not your order" }, 403);
      if (order.status === "picked_up") return json({ error: "That order was already picked up" }, 400);
      if (order.status === "cancelled") return json({ ok: true, refunded: false, already: true });

      let refunded = false, refundId: string | null = null;
      if (order.payment_intent_id) {
        // Both flags matter on a destination charge: reverse_transfer claws the
        // money back out of the truck's connected account (without it the
        // platform absorbs the refund), and refund_application_fee returns our
        // 7% as well — a cancelled order must not earn the platform anything.
        // Refund BEFORE touching the row: if the DB write then fails the order
        // stays visible and the idempotency key makes the retry a no-op, which
        // is the safe direction to fail in.
        try {
          const refund = await stripe("refunds", {
            payment_intent: order.payment_intent_id,
            reverse_transfer: true,
            refund_application_fee: true,
            metadata: { order_id: order.id },
          }, "POST", "refund_" + order.id);
          refunded = true;
          refundId = refund.id;
          console.log("[refund]", order.id, refund.id, refund.status, order.total_cents);
        } catch (e) {
          // The idempotency key only shields repeats for ~24h, and a refund
          // issued by hand in the Dashboard has no key at all. In both cases the
          // student already has their money, so treating this as fatal would
          // strand the order in the queue forever with no way to clear it.
          if (!/already been refunded/i.test((e as Error).message)) throw e;
          refunded = true;
          console.log("[refund]", order.id, "already refunded — cancelling only");
        }
      }

      const now = new Date().toISOString();
      let { error } = await admin.from("orders")
        .update({ status: "cancelled", cancelled_at: now, updated_at: now, refund_id: refundId })
        .eq("id", order.id);
      if (error) ({ error } = await admin.from("orders")
        .update({ status: "cancelled", cancelled_at: now, updated_at: now }).eq("id", order.id));
      if (error) throw new Error(error.message);

      await admin.from("order_status_events").insert({
        order_id: order.id,
        status: "cancelled",
        note: refunded
          ? `cancelled by truck — refunded $${(order.total_cents / 100).toFixed(2)}${refundId ? ` (${refundId})` : " (already refunded)"}`
          : "cancelled by truck — nothing to refund",
      });
      return json({ ok: true, refunded, refund_id: refundId, amount_cents: refunded ? order.total_cents : 0 });
    }

    // ---- student: cancel their own order before the truck confirms ----
    // refunds.html: "You can cancel for a full refund any time before the truck
    // confirms your order." Identity is the device_key, the same trust model
    // my_orders already runs on — students have no login.
    if (action === "student_cancel_order") {
      const { device_key, order_id } = body as { device_key?: string; order_id?: string };
      if (!device_key || !order_id) return json({ error: "Missing order details" }, 400);

      const { data: student } = await admin.from("students").select("id").eq("device_key", device_key).maybeSingle();
      if (!student) return json({ error: "We don't recognise this device" }, 403);

      const { data: order } = await admin.from("orders").select("*").eq("id", order_id).maybeSingle();
      if (!order || order.student_id !== student.id) return json({ error: "Order not found" }, 404);
      if (order.status === "cancelled") return json({ ok: true, refunded: false, already: true });

      // Claim the row and test eligibility in ONE statement. This path refunds
      // AFTER claiming, the reverse of the vendor path, and deliberately so: the
      // student is only entitled to cancel while the order is still 'placed', so
      // checking that first and cancelling second would let the truck confirm in
      // the gap and leave us refunding food already on the grill.
      const now = new Date().toISOString();
      const { data: claimed } = await admin.from("orders")
        .update({ status: "cancelled", cancelled_at: now, updated_at: now })
        .eq("id", order.id).eq("status", "placed").select("id");
      if (!claimed?.length) {
        return json({ error: "The truck has already started this order — message them and we'll sort it out.", code: "too_late" }, 409);
      }

      let refunded = false, refundId: string | null = null;
      if (order.payment_intent_id) {
        try {
          const refund = await stripe("refunds", {
            payment_intent: order.payment_intent_id,
            reverse_transfer: true,
            refund_application_fee: true,
            metadata: { order_id: order.id },
          }, "POST", "refund_" + order.id);
          refunded = true;
          refundId = refund.id;
          console.log("[refund]", order.id, refund.id, refund.status, order.total_cents);
        } catch (e) {
          const msg = (e as Error).message;
          if (!/already been refunded/i.test(msg)) {
            // The row is already cancelled by now, so swallowing this would leave
            // a student out of pocket with nothing recording why. Make it loud in
            // the logs AND on the order's own timeline so it can be found later.
            console.error("[refund] STUDENT CANCEL REFUND FAILED", order.id, msg);
            await admin.from("order_status_events").insert({
              order_id: order.id, status: "cancelled",
              note: `cancelled by student — REFUND FAILED, needs refunding by hand: ${msg}`,
            });
            return json({ error: "Your order is cancelled, but the refund didn't go through automatically. We've flagged it and will refund you by hand.", code: "refund_failed" }, 502);
          }
          refunded = true;
        }
      }
      if (refundId) await admin.from("orders").update({ refund_id: refundId }).eq("id", order.id);

      await admin.from("order_status_events").insert({
        order_id: order.id,
        status: "cancelled",
        note: refunded
          ? `cancelled by student — refunded $${(order.total_cents / 100).toFixed(2)}${refundId ? ` (${refundId})` : " (already refunded)"}`
          : "cancelled by student — nothing to refund",
      });
      return json({ ok: true, refunded, refund_id: refundId, amount_cents: refunded ? order.total_cents : 0 });
    }

    // ---- student: paid checkout ----
    if (action === "create_checkout") {
      const { device_key, student_name, phone, vendor_id, items } = body as {
        device_key: string; student_name: string; phone?: string; vendor_id: string;
        items: { menu_item_id: string; variant_id?: string; modifier_ids?: string[]; quantity: number }[];
      };
      if (!device_key || !student_name?.trim() || !vendor_id || !items?.length) return json({ error: "Missing order details" }, 400);
      // Bound the array: every element becomes a row insert, so an unbounded
      // list is a cheap way to make one request do unbounded database work.
      if (!Array.isArray(items) || items.length > 20) return json({ error: "1-20 items per order" }, 400);

      const { data: vendor } = await admin.from("vendors").select("*").eq("id", vendor_id).maybeSingle();
      if (!vendor || vendor.status !== "approved") return json({ error: "Truck not available" }, 400);
      if (!vendor.is_open || vendor.orders_paused) return json({ error: "This truck isn't accepting orders right now" }, 400);
      if (!vendor.payout_account_id) return json({ error: "This truck isn't set up for card payments yet", code: "no_card_payments" }, 400);

      // Load every referenced item, scoped to this vendor and available.
      const ids = [...new Set(items.map((i) => i.menu_item_id))];
      const { data: menu } = await admin.from("menu_items")
        .select("id,name,price_cents").eq("vendor_id", vendor_id).eq("is_available", true).in("id", ids);
      if (!menu || menu.length !== ids.length) return json({ error: "Some items are no longer available" }, 400);

      // Variants and modifiers for exactly those items. Filtering by
      // menu_item_id IN (this vendor's items) means a variant or modifier from
      // another item — or another truck — is never loaded, so a foreign id sent
      // by the client cannot match anything in the checks below.
      const { data: variants } = await admin.from("menu_item_variants")
        .select("id,menu_item_id,label,price_cents,allows_modifiers").in("menu_item_id", ids);
      const { data: modifiers } = await admin.from("menu_item_modifiers")
        .select("id,menu_item_id,label,price_cents,kind").in("menu_item_id", ids);
      const variantsByItem = new Map<string, any[]>();
      for (const v of variants ?? []) {
        const arr = variantsByItem.get(v.menu_item_id) ?? [];
        arr.push(v); variantsByItem.set(v.menu_item_id, arr);
      }

      // Recompute every price here. The client sends only choices — which item,
      // which size, which toppings — and a display price it does NOT get to
      // decide. This is the single source of truth for what the card is charged.
      let total = 0;
      const lines: { name: string; unit: number; qty: number; item_id: string }[] = [];
      for (const i of items) {
        const m = menu.find((x) => x.id === i.menu_item_id);
        if (!m) return json({ error: "Some items are no longer available" }, 400);
        const qty = Math.max(1, Math.min(20, Math.floor(i.quantity)));

        const itemVariants = variantsByItem.get(m.id) ?? [];
        let variant: any = null;
        if (i.variant_id) {
          variant = itemVariants.find((v) => v.id === i.variant_id) ?? null;
          if (!variant) return json({ error: "That size isn't available for this item." }, 400);
        } else if (itemVariants.length > 0) {
          // Sold by size, but none was chosen. Refuse rather than guess —
          // guessing would charge a whole-pie price for a slice, or the reverse.
          return json({ error: "Choose a size for " + m.name + "." }, 400);
        }

        // Some sizes can't be customised (a slice is "not customizable"). Refuse
        // toppings on them rather than silently charging for something the
        // kitchen won't make.
        if ((i.modifier_ids?.length ?? 0) > 0 && variant && variant.allows_modifiers === false) {
          return json({ error: "That size can't have toppings added." }, 400);
        }

        let unit = variant ? variant.price_cents : m.price_cents;
        const chosenMods: any[] = [];
        for (const mid of i.modifier_ids ?? []) {
          const mod = (modifiers ?? []).find((x) => x.id === mid && x.menu_item_id === m.id);
          if (!mod) return json({ error: "One of the add-ons isn't available for this item." }, 400);
          chosenMods.push(mod);
          unit += mod.price_cents;
        }
        // A sauce (e.g. the free white-sauce swap) is not a topping and does not
        // count toward the cap. Everything else does.
        const sauces = chosenMods.filter((x) => x.kind === "sauce");
        const toppings = chosenMods.filter((x) => x.kind !== "sauce");
        // Daily Dough caps a pizza at three toppings. Enforce it here too, not
        // just in the app, so a crafted request can't stack fifteen.
        if (toppings.length > 3) return json({ error: "Up to 3 toppings per pizza." }, 400);

        // The kitchen ticket and the receipt both read this label, so it has to
        // describe the whole choice even if the menu changes afterwards. Sauce
        // sits with the size (it modifies the base); toppings follow the "+".
        const label = m.name
          + (variant ? " (" + variant.label + (sauces.length ? ", " + sauces.map((x) => x.label).join(", ") : "") + ")" : "")
          + (toppings.length ? " + " + toppings.map((x) => x.label).join(", ") : "");

        total += unit * qty;
        lines.push({ name: label, unit, qty, item_id: m.id });
      }

      let { data: student } = await admin.from("students").select("*").eq("device_key", device_key).maybeSingle();
      if (!student) {
        student = await insertRow("students", { device_key, full_name: student_name.trim(), phone: phone?.trim() || null }, ["phone"]);
      } else {
        await admin.from("students").update({ full_name: student_name.trim(), phone: phone?.trim() || student.phone }).eq("id", student.id);
      }

      const pickup_code = String(Math.floor(1000 + Math.random() * 9000));
      // 'pending_payment' keeps this out of the vendor's queue and suppresses the
      // new-order push until the webhook confirms Stripe took the money.
      const order = await insertRow("orders", {
        student_id: student.id, vendor_id, status: "pending_payment", pickup_code,
        total_cents: total, subtotal_cents: total,
      }, ["subtotal_cents"]);
      for (const ln of lines) {
        await insertRow("order_items", {
          order_id: order.id, menu_item_id: ln.item_id, item_name_snapshot: ln.name,
          unit_price_cents: ln.unit, quantity: ln.qty,
        }, ["menu_item_id"]);
      }

      const { fee, safeBps, safeFixed } = computePlatformFeeCents(total);
      console.log("[fee_debug] " + JSON.stringify({
        order_id: order.id,
        total_cents: total,
        raw_FEE_BPS: FEE_BPS,
        raw_FEE_FIXED_CENTS: FEE_FIXED,
        used_bps: safeBps,
        used_fixed_cents: safeFixed,
        computed_fee_cents: fee,
        computed_fee_dollars: (fee / 100).toFixed(2),
        expected_7pct_cents: Math.round(total * 0.07),
        expected_7pct_dollars: (Math.round(total * 0.07) / 100).toFixed(2),
      }));
      let session;
      try {
        session = await stripe("checkout/sessions", {
          mode: "payment",
          line_items: lines.map((ln) => ({
            quantity: ln.qty,
            price_data: { currency: "usd", unit_amount: ln.unit, product_data: { name: ln.name } },
          })),
          payment_intent_data: { application_fee_amount: fee, transfer_data: { destination: vendor.payout_account_id } },
          metadata: { order_id: order.id },
          success_url: APP_URL + "/index.html?paid=1",
          cancel_url: APP_URL + "/index.html?pay_cancelled=1",
          expires_at: Math.floor(Date.now() / 1000) + 1800,
        });
      } catch (e) {
        // The order row was inserted before this call, so a rejection here
        // strands it. Nothing will ever clear it on its own: no session was
        // created, so checkout.session.expired never fires for it, and the row
        // sits at 'pending_payment' forever showing the student a ghost order.
        // Take it back out before returning.
        const now = new Date().toISOString();
        await admin.from("orders")
          .update({ status: "cancelled", cancelled_at: now, updated_at: now })
          .eq("id", order.id).eq("status", "pending_payment");

        const msg = (e as Error).message;
        console.error("[checkout] session rejected for order", order.id, "-", msg);
        // A truck whose Connect account has no transfers capability is not a
        // server fault and the student can do nothing about it, so it must not
        // surface as the generic "something went wrong". This is the same
        // situation as having no payout account at all — onboarding is simply
        // unfinished — so it returns the same code the app already handles.
        if (/capabilit|transfers|charges_enabled|not.*activated/i.test(msg)) {
          return json({
            error: "This truck hasn't finished setting up card payments yet — check back soon.",
            code: "no_card_payments",
          }, 400);
        }
        throw e;
      }
      return json({ url: session.url, order_id: order.id, pickup_code });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    // Deliberate refusals above are returned via json() and keep their wording.
    // Anything reaching here is unexpected — Stripe or Postgres text, which can
    // name internals — so it is logged and the caller gets something generic.
    console.error("[stripe] unhandled:", (e as Error).message);
    return json({ error: "Something went wrong. Try again in a moment." }, 400);
  }
});
