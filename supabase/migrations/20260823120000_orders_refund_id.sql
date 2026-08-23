-- Store the Stripe refund id on the order it belongs to
--
-- Both cancel paths in the stripe function already try to write refund_id and
-- fall back to an update without it when the column is missing — which is why
-- refunds have worked while the value went only into the order's timeline note.
-- Adding the column lets a refund be looked up directly instead of parsed out
-- of free text. Nullable: an order cancelled before payment has nothing to
-- refund, and old orders predate the column.

alter table public.orders
  add column if not exists refund_id text;
