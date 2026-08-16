// Bobcat Bites API — hardened
// Security notes:
//   • Admin PIN: read from env; constant-time compare; brute-force rate limiting
//     with lockout. Set a strong ADMIN_PIN secret (Dashboard → Edge Functions →
//     Secrets). There is no hardcoded fallback — admin fails closed if unset.
//   • vendor_signup: per-IP rate limiting; no listUsers({perPage:1000}) full-table
//     scan (user enumeration + perf cliff). Handles "already exists" without
//     enumerating every user.
//   • 500s do not leak internal error detail to the client.
//   • place_order REMOVED. It created an order at status 'placed' with no payment
//     of any kind, and notify_new_order fires on entry to 'placed' — so an
//     unauthenticated POST put a real ticket on a truck's screen and had food
//     cooked for free. verify_jwt is false on this function and device_key is
//     invented by the caller, so there was nothing to validate against. All
//     ordering now goes through the stripe function's create_checkout, where the
//     order is only promoted to 'placed' by a signature-verified webhook.
import { createClient } from "jsr:@supabase/supabase-js@2";

const ADMIN_PIN = Deno.env.get("ADMIN_PIN") ?? ""; // no fallback — set the secret

// Pinned to the production origins. This is defence in depth, not a boundary:
// CORS constrains browsers, not curl, so it never stands in for the auth and
// rate-limit checks below.
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
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// constant-time string compare (avoids timing oracle on the PIN)
function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

// ---- tiny in-memory rate limiter (per isolate). Not perfect across many
//      isolates, but it turns a 1M-guess brute force into an impractical one
//      and throttles signup abuse. ----
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

Deno.serve(async (req: Request) => {
  // Built per request so the echoed origin matches the caller; a module-level
  // object would be shared across concurrent requests.
  const cors = corsFor(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const action = body?.action;
  const ip = clientIp(req);

  try {
    if (action === "health") return json({ ok: true, time: new Date().toISOString() });

    // ---------- vendor: signup ----------
    if (action === "vendor_signup") {
      const rl = rateLimit(`signup:${ip}`, 5, 60 * 60 * 1000); // 5 new accounts / hr / IP
      if (!rl.ok) return json({ error: "Too many signups from this network. Try again later." }, 429);

      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Enter a valid email address" }, 400);
      if (password.length < 6) return json({ error: "Password must be at least 6 characters" }, 400); // matches the vendor app's client-side rule; raise both to 8+ later

      const created = await db.auth.admin.createUser({ email, password, email_confirm: true });
      if (!created.error) return json({ ok: true });
      if (/already|exists|registered/i.test(created.error.message)) {
        // Do NOT enumerate all users. Just tell them to log in.
        return json({ error: "That email already has an account — use Log in instead" }, 409);
      }
      throw created.error;
    }

    // ---------- student: my orders ----------
    if (action === "my_orders") {
      const { device_key } = body;
      if (typeof device_key !== "string" || device_key.length < 16) return json({ error: "Missing/short device_key" }, 400);
      const { data: student } = await db.from("students").select("id").eq("device_key", device_key).maybeSingle();
      if (!student) return json({ ok: true, orders: [] });
      const { data: orders, error } = await db.from("orders")
        .select("id,status,eta_minutes,confirmed_at,ready_at,picked_up_at,cancelled_at,pickup_code,total_cents,created_at,vendors(name,default_location),order_items(item_name_snapshot,quantity,unit_price_cents)")
        .eq("student_id", student.id).order("created_at", { ascending: false }).limit(10);
      if (error) throw error;
      return json({ ok: true, orders });
    }

    // ---------- admin ----------
    if (action === "admin_list" || action === "admin_set_status") {
      if (!ADMIN_PIN) return json({ error: "Admin is not configured" }, 503);
      const rl = rateLimit(`admin:${ip}`, 5, 10 * 60 * 1000, 30 * 60 * 1000); // 5 tries / 10 min, then 30 min lockout
      if (!rl.ok) return json({ error: `Too many attempts. Try again in ${rl.retryAfter}s.` }, 429);
      if (typeof body.pin !== "string" || !timingSafeEqual(body.pin, ADMIN_PIN)) return json({ error: "Bad PIN" }, 401);

      if (action === "admin_list") {
        const { data: vendors, error } = await db.from("vendors")
          .select("id,name,description,contact_phone,contact_email,status,is_open,default_location,created_at")
          .order("created_at", { ascending: false });
        if (error) throw error;
        return json({ ok: true, vendors });
      }

      const { vendor_id, status } = body;
      if (!["approved", "pending", "suspended"].includes(status)) return json({ error: "Bad status" }, 400);
      const { error } = await db.from("vendors").update({ status, updated_at: new Date().toISOString() }).eq("id", vendor_id);
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (e) {
    console.error(e); // full detail stays in server logs
    return json({ error: "Server error" }, 500); // generic to the client
  }
});
