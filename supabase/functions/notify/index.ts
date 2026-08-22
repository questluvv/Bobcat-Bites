// Bobcat Bites — order notifier
//
// Routes:
//   POST /notify/subscribe   PUBLIC — browser registers a web-push subscription.
//   POST /notify             Trigger-only (x-notify-secret). Event shapes:
//                              1) NEW ORDER      → web-push the vendor
//                              2) status_change  → web-push + SMS the student
//                              3) admin_alert    → web-push + SMS the operator
//                              4) config_check   → which secrets are set (booleans only)
//
// NOTE: push_subscriptions.endpoint is a GENERATED column
// (subscription ->> 'endpoint') — never write to it directly.
import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const NOTIFY_SECRET = Deno.env.get("NOTIFY_SECRET") ?? "";

// The VAPID keypair lives ONLY in Edge Function secrets. It used to have
// hardcoded fallbacks, which is what kept this file out of the public repo.
//
// setVapidDetails() throws on empty input and runs at module load, so calling it
// unguarded would take the entire function down — /subscribe and config_check
// included — the moment a secret went missing. That is the exact failure the
// fallbacks were papering over, and a boot loop hides the cause. Guarding it
// instead keeps the diagnostic reachable, so a missing key is something you can
// SEE rather than something that silently stops every channel at once.
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC") ?? "";
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE") ?? "";
const VAPID_READY = !!(VAPID_PUBLIC && VAPID_PRIVATE);

if (VAPID_READY) {
  webpush.setVapidDetails("mailto:bigmansmoky@gmail.com", VAPID_PUBLIC, VAPID_PRIVATE);
} else {
  console.error('[config] VAPID_PUBLIC / VAPID_PRIVATE are not set — push is DISABLED. POST {"event":"config_check"} with the x-notify-secret header to confirm.');
}

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

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
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-notify-secret",
  };
}

// ---- tiny in-memory rate limiter (per isolate). Same shape as the one in the
//      api function, kept as its own copy because edge functions do not share
//      modules. /subscribe is the only public route here and it writes with the
//      service role, so an unthrottled caller could fill push_subscriptions at
//      will. Per-isolate counting is imperfect but turns that into a grind. ----
type Bucket = { count: number; resetAt: number; lockedUntil?: number };
const buckets = new Map<string, Bucket>();
function rateLimit(key: string, max: number, windowMs: number, lockMs = 0): { ok: boolean; retryAfter?: number } {
  const now = Date.now();
  let b = buckets.get(key);
  if (b?.lockedUntil && now < b.lockedUntil) return { ok: false, retryAfter: Math.ceil((b.lockedUntil - now) / 1000) };
  if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + windowMs }; buckets.set(key, b); }
  b.count++;
  if (b.count > max) {
    if (lockMs) b.lockedUntil = now + lockMs;
    return { ok: false, retryAfter: Math.ceil(((b.lockedUntil ?? b.resetAt) - now) / 1000) };
  }
  return { ok: true };
}
const clientIp = (req: Request) =>
  req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("cf-connecting-ip") || "unknown";

function toE164US(raw?: string | null): string | null {
  if (!raw) return null;
  const t = String(raw).trim();
  if (t.startsWith("+")) return "+" + t.slice(1).replace(/\D/g, "");
  const d = t.replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return null;
}

const TRIAL_RESTRICTION_CODES = new Set([572006, 572002, 0]);

// Twilio ACCEPTING a message is not the same as a carrier DELIVERING it.
// While A2P 10DLC registration is incomplete, US carriers drop this traffic
// after Twilio has already returned 201 — so a "sent" here can still mean the
// operator's phone stays silent. Never treat this as a confirmed alert.
async function sendTwilioSMS(to: string, bodyText: string, fallbackTemplate?: string) {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const token = Deno.env.get("TWILIO_AUTH_TOKEN");
  const from = Deno.env.get("TWILIO_PHONE_NUMBER");
  if (!sid || !token || !from) throw new Error("Twilio secrets not configured");
  if (!to) throw new Error("no destination phone number");
  if (to === from) throw new Error(`destination equals Twilio number (${from})`);

  const post = async (body: string) => {
    const params = new URLSearchParams({ To: to, From: from, Body: body });
    return await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${sid}:${token}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });
  };

  const res = await post(bodyText);
  if (res.ok) return { sent: true, mode: "queued_with_twilio" as const };

  const detail = await res.text().catch(() => "");
  let errCode: number | undefined;
  try {
    const parsed = JSON.parse(detail);
    if (typeof parsed?.code === "number") errCode = parsed.code;
  } catch { /* not JSON */ }

  const isTrialRestriction = res.status === 400 && errCode !== undefined && TRIAL_RESTRICTION_CODES.has(errCode);
  if (isTrialRestriction && fallbackTemplate) {
    const res2 = await post(fallbackTemplate);
    if (res2.ok) return { sent: true, mode: "trial_template" as const, template: fallbackTemplate };
    const detail2 = await res2.text().catch(() => "");
    throw new Error(`Twilio ${res2.status} (template ${fallbackTemplate}): ${detail2}`);
  }
  throw new Error(`Twilio ${res.status}: ${detail}`);
}

async function pushToSubscriptions(
  subs: { id: string; subscription: unknown }[],
  payload: Record<string, unknown>,
): Promise<{ sent: number; errors: string[] }> {
  // Without keys every send would throw identically per subscription and bury
  // the real cause in noise. Say it once, plainly.
  if (!VAPID_READY) return { sent: 0, errors: ["VAPID keys not configured — push disabled"] };

  const body = JSON.stringify(payload);
  let sent = 0;
  const errors: string[] = [];
  for (const s of subs) {
    try {
      await webpush.sendNotification(s.subscription as any, body);
      sent++;
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        await db.from("push_subscriptions").delete().eq("id", s.id);
      } else {
        errors.push(`${e?.statusCode ?? "?"}: ${e?.message ?? e}`);
        console.error("push failed", e?.statusCode, e?.message);
      }
    }
  }
  return { sent, errors };
}

Deno.serve(async (req: Request) => {
  // Per request so the echoed origin matches the caller. Matters most for
  // /subscribe, which is public and unauthenticated.
  const CORS = corsFor(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return new Response("POST only", { status: 405, headers: CORS });

  const url = new URL(req.url);

  // ============ PUBLIC: register / remove a push subscription ============
  // This route runs on the service role, so whatever it accepts it performs
  // with full authority and RLS never sees it. It exists ONLY for students,
  // who have no login and are identified by a device_key they generated.
  if (url.pathname.endsWith("/subscribe")) {
    // 20 per 10 minutes per IP. A real phone registers once and then only again
    // after the browser rotates the subscription, so this is far above anything
    // honest traffic does and still caps a scripted flood.
    const rl = rateLimit(`sub:${clientIp(req)}`, 20, 10 * 60 * 1000);
    if (!rl.ok) return json({ error: "Too many attempts. Try again shortly.", retry_after: rl.retryAfter }, 429);

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const { device_key, vendor_id, subscription, unsubscribe } = body as {
      device_key?: string; vendor_id?: string; subscription?: { endpoint?: string }; unsubscribe?: boolean;
    };

    // A vendor subscription used to be accepted here from anyone who could name
    // a vendor_id — and vendor pushes describe incoming orders, so that handed
    // a stranger a live feed of a truck's trade on their own phone. No client
    // ever used it: the vendor app writes to push_subscriptions directly, where
    // the RLS policy checks vendors.owner_user_id = auth.uid() and is the only
    // path that can actually prove ownership. So this is closed rather than
    // re-authenticated, which would only rebuild what RLS already does.
    if (vendor_id) {
      return json({ error: "Vendor alerts are enabled from the vendor app while signed in." }, 403);
    }
    if (!device_key) return json({ error: "device_key required" }, 400);
    if (typeof device_key !== "string" || device_key.length < 16) {
      return json({ error: "Missing/short device_key" }, 400);
    }
    if (!subscription?.endpoint) return json({ error: "subscription with endpoint required" }, 400);

    if (unsubscribe) {
      await db.from("push_subscriptions").delete().eq("endpoint", subscription.endpoint);
      return json({ ok: true, removed: true });
    }

    await db.from("push_subscriptions").delete().eq("endpoint", subscription.endpoint);
    const { error } = await db.from("push_subscriptions").insert({
      device_key: device_key ?? null,
      vendor_id: vendor_id ?? null,
      subscription,
    });
    if (error) {
      console.error("[subscribe] insert failed:", error.message);
      // This route is public and unauthenticated; a raw Postgres message here
      // would name columns and constraints to anyone who pokes at it.
      return json({ error: "Couldn't save the subscription" }, 400);
    }
    return json({ ok: true, subscribed: true });
  }

  // ============ Everything below is trigger-only ============
  if (!NOTIFY_SECRET || req.headers.get("x-notify-secret") !== NOTIFY_SECRET) {
    return new Response("forbidden", { status: 403, headers: CORS });
  }

  const payload = await req.json().catch(() => ({} as Record<string, unknown>));

  // ============ 4) CONFIG CHECK → which secrets are actually set ============
  // Booleans only — never returns a secret value. Exists because the dashboard
  // is easy to misread, and deleting the VAPID fallbacks while the secrets were
  // unset would have silently killed every notification channel at once.
  if (payload.event === "config_check") {
    return json({
      ok: true,
      vapid_public_set: !!VAPID_PUBLIC,
      vapid_private_set: !!VAPID_PRIVATE,
      // Kept so the response shape stays stable for anything watching it; the
      // hardcoded fallbacks no longer exist, so this can only ever be false now.
      using_hardcoded_vapid_fallback: false,
      push_enabled: VAPID_READY,
      notify_secret_set: !!Deno.env.get("NOTIFY_SECRET"),
      twilio_sid_set: !!Deno.env.get("TWILIO_ACCOUNT_SID"),
      twilio_token_set: !!Deno.env.get("TWILIO_AUTH_TOKEN"),
      twilio_number_set: !!Deno.env.get("TWILIO_PHONE_NUMBER"),
    });
  }

  // ============ 3) ADMIN ALERT → push + SMS the operator ============
  // Fired by alert_stuck_payments(). Goes to the operator only.
  // Push is the PRIMARY channel here: SMS is currently dropped by carriers
  // pending A2P 10DLC registration, so an SMS-only alert would be silent —
  // exactly the failure mode this watchdog exists to prevent.
  if (payload.event === "admin_alert") {
    const { customer_phone, message, admin_device_keys } = payload as {
      customer_phone?: string; message?: string; admin_device_keys?: string[];
    };
    if (!message) return json({ ok: true, sent: 0, error: "missing message" });

    const result: Record<string, unknown> = { ok: true };

    // (a) web push — works today
    try {
      const keys = Array.isArray(admin_device_keys) ? admin_device_keys.filter(Boolean) : [];
      if (keys.length) {
        const { data: subs } = await db.from("push_subscriptions").select("id,subscription").in("device_key", keys);
        if (subs?.length) {
          const r = await pushToSubscriptions(subs, {
            title: "⚠️ Bobcat Bites: stuck payment",
            body: message,
            tag: "bb-admin-alert",
            url: "./index.html",
            audience: "student", // renders with the student icon; operator uses that app
          });
          result.push_sent = r.sent;
          if (r.errors.length) result.push_errors = r.errors;
        } else {
          result.push_sent = 0;
          result.push_note = "no push subscriptions for admin device keys";
        }
      } else {
        result.push_sent = 0;
        result.push_note = "no admin_device_keys supplied";
      }
    } catch (e: any) {
      result.push_sent = 0;
      result.push_error = String(e?.message ?? e);
      console.error("[admin_alert] push failed:", e?.message ?? e);
    }

    // (b) SMS — queued, but carriers may drop it until A2P clears
    const to = toE164US(customer_phone);
    if (to) {
      try {
        const r = await sendTwilioSMS(to, message, "sms_order_confirmation");
        result.sms_queued = 1;
        result.sms_mode = r.mode;
      } catch (e: any) {
        result.sms_queued = 0;
        result.sms_error = String(e?.message ?? e);
        console.error("[admin_alert] SMS failed:", e?.message ?? e);
      }
    }

    console.log("[admin_alert]", JSON.stringify(result), "|", message);
    return json(result);
  }

  // ============ 2) STATUS CHANGE → push + SMS the student ============
  if (payload.event === "status_change") {
    const { order_id, new_status, customer_phone, pickup_code, eta_minutes } = payload as {
      order_id?: string; new_status?: string; customer_phone?: string;
      pickup_code?: string; eta_minutes?: number;
    };

    let title: string | null = null;
    let message: string | null = null;
    let fallbackTemplate: string | undefined;

    if (new_status === "ready") {
      title = "Order ready for pickup 🔔";
      message = `Your order at Bobcat Bites is ready!${pickup_code ? ` Show code ${pickup_code}.` : ""} 🌮`;
      fallbackTemplate = "sms_order_confirmation";
    } else if (new_status === "confirmed") {
      const eta = typeof eta_minutes === "number" && eta_minutes > 0 ? ` ~${eta_minutes} min` : "";
      const code = pickup_code ? ` Pickup code: ${pickup_code}.` : "";
      title = "Order confirmed 🎉";
      message = `Bobcat Bites confirmed your order.${eta ? " Ready in" + eta + "." : ""}${code} We'll let you know when it's ready.`;
      fallbackTemplate = "sms_order_confirmation";
    } else if (new_status === "cancelled") {
      // A cancel means two very different things depending on whether money moved.
      // An abandoned Checkout session expiring also lands here, and telling a
      // student they've been refunded when they were never charged is alarming
      // nonsense — so only an order with a payment behind it gets the message.
      // refunds.html promises the refund is automatic; this is how they hear that
      // it happened, since a card refund takes days to surface on a statement.
      const { data: o } = await db.from("orders").select("payment_intent_id").eq("id", order_id ?? "").maybeSingle();
      if (!o?.payment_intent_id) {
        return json({ ok: true, sent: 0, note: "cancelled before payment — nothing to tell the student" });
      }
      title = "Order cancelled — refunded 💳";
      message = `Bobcat Bites couldn't complete your order${pickup_code ? ` (code ${pickup_code})` : ""}. You've been refunded in full — it can take 5-10 business days to appear on your card.`;
      fallbackTemplate = "sms_order_confirmation";
    }

    if (!message || !title) {
      return json({ ok: true, sent: 0, note: `no notification for status ${new_status}` });
    }

    const result: Record<string, unknown> = { ok: true, order_id, status: new_status };

    try {
      const { data: order } = await db.from("orders").select("student_id").eq("id", order_id).maybeSingle();
      let deviceKey: string | null = null;
      if (order?.student_id) {
        const { data: student } = await db.from("students").select("device_key").eq("id", order.student_id).maybeSingle();
        deviceKey = student?.device_key ?? null;
      }
      if (deviceKey) {
        const { data: subs } = await db.from("push_subscriptions").select("id,subscription").eq("device_key", deviceKey);
        if (subs?.length) {
          const r = await pushToSubscriptions(subs, {
            title,
            body: message,
            tag: "bb-order-" + (order_id ?? "update"),
            url: "./index.html",
            audience: "student",
          });
          result.push_sent = r.sent;
          if (r.errors.length) result.push_errors = r.errors;
        } else {
          result.push_sent = 0;
          result.push_note = "no push subscriptions for this device";
        }
      } else {
        result.push_sent = 0;
        result.push_note = "could not resolve device_key for order";
      }
    } catch (e: any) {
      result.push_sent = 0;
      result.push_error = String(e?.message ?? e);
      console.error("[push] student push failed for order", order_id, "-", e?.message ?? e);
    }

    const to = toE164US(customer_phone);
    if (!to) {
      console.error("[sms] unusable phone for order", order_id, "raw:", customer_phone);
      result.sms_sent = 0;
      result.sms_error = `unusable phone number: ${customer_phone ?? "(none)"}`;
      return json(result);
    }
    try {
      const r = await sendTwilioSMS(to, message, fallbackTemplate);
      result.sms_sent = 1;
      result.sms_to = to;
      result.sms_mode = r.mode;
    } catch (e: any) {
      console.error("[sms] failed for order", order_id, "status", new_status, "-", e?.message ?? e);
      result.sms_sent = 0;
      result.sms_error = String(e?.message ?? e);
    }
    return json(result);
  }

  // ============ 1) NEW ORDER → web-push the vendor ============
  const { order_id, vendor_id, total_cents } = payload as {
    order_id?: string; vendor_id?: string; total_cents?: number;
  };
  if (!vendor_id) return json({ error: "vendor_id required" }, 400);

  const { data: subs } = await db.from("push_subscriptions").select("id,subscription").eq("vendor_id", vendor_id);
  if (!subs?.length) return json({ ok: true, sent: 0, note: "no subscriptions" });

  // The pickup code used to be in this line. It is the one thing that proves a
  // student is collecting their own order, and a notification body is readable
  // on a locked screen — so it does not belong in a preview. Anyone holding this
  // subscription would have been handed every code as it was issued. The vendor
  // taps through to the app, which shows the code against the order anyway.
  const r = await pushToSubscriptions(subs, {
    title: "🔔 New order!",
    body: `$${((total_cents ?? 0) / 100).toFixed(2)} — tap to confirm.`,
    tag: order_id ?? "new-order",
    url: "./vendor_app.html",
    audience: "vendor",
  });
  return json({ ok: true, sent: r.sent, errors: r.errors.length ? r.errors : undefined });
});
