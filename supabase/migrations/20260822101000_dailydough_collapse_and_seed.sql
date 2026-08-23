-- Collapse Daily Dough's duplicate whole/slice rows into one item + variants,
-- and seed drinks + toppings so the size/topping/drink flow is real
--
-- Before: each pizza was up to two menu_items rows — an "18\" Whole" row and a
-- "Slice" row — distinguished only by a size word buried in the description.
-- After: one row per pizza, with a menu_item_variants row per size. The old
-- prices and prep times move onto the variants unchanged, so Daily Dough's menu
-- totals to exactly the same numbers; nothing is repriced here.
--
-- Two pizzas (Saucy Buffalo, Veggie Garden) only ever had a whole row, so they
-- get a single "18\" Whole" variant. That is fine — an item may have 1..n.
--
-- Deleting the slice rows is safe for history: order_items.menu_item_id is
-- ON DELETE SET NULL and every order_items row already carries its own
-- item_name_snapshot and unit_price_cents, so past receipts keep reading right.
--
-- The whole thing is guarded to run once: if Daily Dough already has any
-- variants, it does nothing, so re-applying is harmless. On a fresh project
-- there is no Daily Dough vendor, so every statement below simply matches no
-- rows.

do $$
declare
  dd uuid;
begin
  select id into dd from public.vendors where lower(name) like '%daily dough%' limit 1;
  if dd is null then
    raise notice 'no Daily Dough vendor — nothing to migrate';
    return;
  end if;
  if exists (
    select 1 from public.menu_item_variants v
    join public.menu_items mi on mi.id = v.menu_item_id
    where mi.vendor_id = dd
  ) then
    raise notice 'Daily Dough already has variants — skipping';
    return;
  end if;

  -- Classify every current pizza row: is it a slice, what size label does it
  -- carry, and what is the topping list once the size prefix is removed.
  create temporary table _dd_rows on commit drop as
  select mi.id, mi.name, mi.price_cents, mi.default_prep_minutes,
    (lower(mi.description) like 'slice%') as is_slice,
    trim(split_part(mi.description, ' · ', 1)) as size_label,
    nullif(trim(substr(mi.description, position(' · ' in mi.description) + 3)), '') as toppings
  from public.menu_items mi
  where mi.vendor_id = dd and mi.category = 'main';

  -- The row to keep for each name: its whole row (highest priced non-slice).
  create temporary table _dd_keeper on commit drop as
  select distinct on (name) id as keep_id, name, toppings
  from _dd_rows
  where not is_slice
  order by name, price_cents desc;

  -- A variant for every original row, attached to its name's keeper. The size
  -- label ("18\" Whole" / "Slice") comes straight from the old description;
  -- whole sorts before slice.
  insert into public.menu_item_variants (menu_item_id, label, price_cents, prep_minutes, sort)
  select k.keep_id, r.size_label, r.price_cents, r.default_prep_minutes,
         case when r.is_slice then 1 else 0 end
  from _dd_rows r
  join _dd_keeper k on k.name = r.name;

  -- Strip the size prefix from the kept rows so the card shows just the toppings.
  update public.menu_items mi
     set description = k.toppings, updated_at = now()
  from _dd_keeper k
  where mi.id = k.keep_id;

  -- Remove the now-duplicate slice rows.
  delete from public.menu_items
  where id in (select id from _dd_rows where is_slice);

  -- ---- Seed: toppings on every pizza -----------------------------------------
  -- PLACEHOLDER add-ons and prices, added so the topping feature is usable and
  -- testable. Quest/Veronica should confirm or change these. Two per pizza.
  insert into public.menu_item_modifiers (menu_item_id, label, price_cents, sort)
  select k.keep_id, x.label, x.price_cents, x.sort
  from _dd_keeper k
  cross join (values ('Extra cheese', 200, 0), ('Extra pepperoni', 250, 1)) as x(label, price_cents, sort);

  -- ---- Seed: drinks ----------------------------------------------------------
  -- PLACEHOLDER drinks and prices, added so the drink pill row and the upsell
  -- have something to show. category='drink' routes them to the pill row.
  insert into public.menu_items (vendor_id, name, description, price_cents, category, is_available, default_prep_minutes)
  values
    (dd, 'Coca-Cola',     'Can',           200, 'drink', true, 1),
    (dd, 'Sprite',        'Can',           200, 'drink', true, 1),
    (dd, 'Bottled Water', '16.9 fl oz',    150, 'drink', true, 1);

  raise notice 'Daily Dough menu collapsed and seeded';
end $$;
