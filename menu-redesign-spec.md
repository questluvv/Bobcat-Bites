# Spec: Menu items with sizes, toppings & drinks (student app)

Hand-off for Claude Code. Work on a branch, open a PR, and test a real checkout with card `4242 4242 4242 4242` before merging. Do NOT regress server-side price integrity (see §4 — this is the one that can lose real money).

## 1. Why
Daily Dough currently lists each pizza twice (whole + slice) as separate menu items — cluttered, and it gets worse as they add items. Vendor request: one menu item per pizza; tapping it opens a detail view to pick **size (whole/slice)**, optionally **add toppings**, and optionally **add a drink**. Drinks shown as a **pill selector at the top of the menu**.

## 2. Goal UX (student app, `index.html`)
- Menu shows **one card per pizza** ("Triple Threat"), not one per size.
- A **row of drink pills at the top** of the menu (Coke / Sprite / etc.) — tap to add a drink straight to cart.
- Tapping a pizza opens a **detail sheet**:
  - **Size** — required radio/segmented control (Whole / Slice) with each price shown.
  - **Extra toppings** — optional checkboxes, each with a `+$` price.
  - **Add a drink?** — optional upsell (same drink list), so they don't have to scroll back up.
  - Quantity + "Add to cart" showing the live composed price.
- Cart lines reflect the full choice, e.g. *"Triple Threat (Whole) · extra pepperoni · ×1"*.

## 3. Data model (Supabase) — the proper version
Keep it backward-compatible so **every other vendor's flat items keep working untouched**. Items with no variants behave exactly as today.

- `menu_items`: add `category text not null default 'main'` (values: `main` | `drink` | `side`). Existing rows default to `main`. Keep `price_cents` as the base/fallback price for items that have **no** variants.
- New table `menu_item_variants`: `id`, `menu_item_id fk`, `label text` ("Whole"/"Slice"), `price_cents int`, `prep_minutes int null`, `sort int`. A pizza has 1..n variants; a flat item has 0.
- New table `menu_item_modifiers`: `id`, `menu_item_id fk`, `label text` ("Extra pepperoni"), `price_cents int`, `sort int`. Optional add-ons; 0..n per item.
- RLS: mirror whatever policy `menu_items` already uses (public read of available items; vendor-owner write). **Also export these new tables + policies as a migration in `supabase/migrations/`** — the repo currently has no schema in git, so add it here rather than clicking in the dashboard.

## 4. Server-side price integrity — CRITICAL, do not skip
`supabase/functions/stripe/index.ts` → `create_checkout` currently trusts only `{menu_item_id, quantity}` and computes `total += m.price_cents * qty`. With sizes/toppings the client will send choices — **never trust a client-sent price.** Recompute authoritatively:

- New item payload shape: `{ menu_item_id, variant_id?, modifier_ids?: string[], quantity }`.
- Server: load the item, its chosen variant (must belong to that item), and the chosen modifiers (must belong to that item). Compute `unit = (variant?.price_cents ?? item.price_cents) + sum(modifier.price_cents)`. Reject if `variant_id` doesn't belong to the item, or if a modifier is foreign, or if the item has variants but none was chosen.
- Snapshot the full choice into `order_items` (extend it): keep `item_name_snapshot` as the composed label (e.g. "Triple Threat (Whole) + Extra pepperoni") and `unit_price_cents` as the computed unit price, so the vendor's kitchen ticket and receipts read correctly even if the menu changes later.
- Keep the existing 1–20 items bound and the `is_available` / vendor-approved / open checks.

## 5. Client changes (`index.html`)
- Menu render (~L352 query + the menu list): fetch `category`, plus variants + modifiers per item (either a join/embedded select or a second query). Split rendering: `category='drink'` → the top pill row; `main`/`side` → cards.
- Cart model currently keys by `menu_item_id`. Change a cart line to carry `{ menu_item_id, variant_id, modifier_ids[], quantity }` and a composed display label + computed price (client price is display-only; §4 is the source of truth).
- The checkout call must send the new item shape from §4.
- Keep the existing **photos + peek-art** working on the pizza cards.

## 6. Data migration (Daily Dough's existing rows)
Currently each pizza is two rows (whole + slice). Migrate: for each pizza name, keep one `menu_items` row, create two `menu_item_variants` ("Whole", "Slice") from the two old rows' prices/prep, delete the duplicate row. Set drink items to `category='drink'`. Write this as a migration/script; don't hand-edit in prod. Verify Daily Dough's menu still totals correctly after.

## 7. Guardrails / done =
- Branch + PR; no direct pushes to `main`.
- A real order (pizza + size + a topping + a drink) checks out with `4242…`, the Stripe amount matches the composed total, and it lands on the vendor screen with the right label.
- A flat-item vendor (no variants) still orders exactly as before — no regression.
- New tables + RLS committed as a migration under `supabase/migrations/`.
- Attempting to send a mismatched/foreign `variant_id` or `modifier_id`, or a whole pizza with a slice's variant, is rejected server-side.

## Note for the operator (Quest)
This is the "structured sizes/modifiers" roadmap item pulled forward. It also finally puts real schema into git (§3/§6), which was an open security item — nice two-birds. It does **not** touch the outstanding money-safety fixes; do those separately.
