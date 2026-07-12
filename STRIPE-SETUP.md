# Turning on real payments (Stripe Connect)

The app ships with everything wired but **dormant**: until the `stripe` edge
function is deployed with keys, students see demo pay and vendors see no
payout card. No code changes are needed to activate it — just the steps below.

## How the money flows

Student pays in the app → Stripe splits the payment automatically:

| Who | Gets |
|---|---|
| Stripe | ~2.9% + 30¢ processing (see stripe.com/pricing) |
| **You (platform fee)** | `PLATFORM_FEE_BPS` of the order (default 700 = 7%) + `PLATFORM_FEE_FIXED_CENTS` (default 0) |
| The truck | Everything else, auto-deposited to their bank |

Vendors onboard themselves through a Stripe-hosted flow (the "Set up payouts"
card in My Truck) — you never see or store their bank details, and Stripe
handles their 1099 tax forms.

## Activation checklist

1. **Create a Stripe account** at stripe.com, then enable **Connect**
   (Dashboard → Connect → Get started → platform/marketplace, Express accounts).

2. **Run the pending migration** (Supabase Dashboard → SQL Editor) — also
   activates the break-timer countdown:
   ```sql
   alter table public.vendors add column if not exists paused_until timestamptz;
   ```
   The `orders.status` column must allow the value `pending_payment` (if it's a
   Postgres enum or has a CHECK constraint, add that value; plain text needs
   nothing).

3. **Deploy the function** (from the repo root, with the Supabase CLI):
   ```bash
   supabase functions deploy stripe --no-verify-jwt --project-ref gqwihtfjmxqxkzssnsrk
   ```
   `--no-verify-jwt` is required — Stripe's webhook calls don't carry a
   Supabase JWT. The function does its own auth on every route.

4. **Set the secrets** (Dashboard → Edge Functions → stripe → Secrets):
   - `STRIPE_SECRET_KEY` — start with the `sk_test_...` key
   - `STRIPE_WEBHOOK_SECRET` — created in step 5 (deploy first, then come back)
   - optional: `PLATFORM_FEE_BPS`, `PLATFORM_FEE_FIXED_CENTS`, `APP_URL`

5. **Add the webhook** (Stripe Dashboard → Developers → Webhooks → Add endpoint):
   - URL: `https://gqwihtfjmxqxkzssnsrk.supabase.co/functions/v1/stripe/webhook`
   - Events: `checkout.session.completed`, `checkout.session.expired`
   - Copy the signing secret (`whsec_...`) into `STRIPE_WEBHOOK_SECRET` (step 4).

6. **Test in test mode**: onboard a truck with Stripe's test onboarding
   (fake SSN 000-00-0000 etc.), order as a student with card `4242 4242 4242 4242`,
   confirm the order flips from "pending payment" to "placed", then check
   Dashboard → Payments shows your application fee split out.

7. **Go live**: swap `sk_test_` for `sk_live_` and recreate the webhook in
   live mode. That's it — the frontend flips from demo pay to card pay on its
   own the moment the `status` probe sees keys.

## Notes

- If a truck hasn't finished Stripe onboarding, students can still order from
  it via demo pay (the backend returns `no_card_payments` and the app falls
  back). Once the truck's `charges_enabled` flips, its orders become card-only.
- Orders sit at `pending_payment` (hidden from the vendor) until the webhook
  confirms payment; abandoned checkouts auto-cancel when the session expires
  (30 min).
- Vendor push notifications for *paid* orders fire on the vendor app's normal
  8s poll. Wiring the closed-app web push for paid orders into the webhook is
  a follow-up (the push-send code lives in the `api` function, which this
  function deliberately doesn't touch).
