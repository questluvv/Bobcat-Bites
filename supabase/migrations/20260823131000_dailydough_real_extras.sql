-- Daily Dough's real toppings, drinks and dip extras, from their menu
--
-- Replaces the placeholder toppings/drinks seeded earlier with the actual menu.
-- Every price is the board price marked up by the agreed platform fee, the same
-- basis as the pizzas: app = round(board / 0.93 / 0.25) * 0.25 (7% fee baked in,
-- rounded to the nearest 25c). Board -> app:
--   meat topping  $3.25 -> $3.50    soda   $2.75 -> $3.00
--   veg topping   $2.25 -> $2.50    water  $1.25 -> $1.25
--   ranch/spicy   $2.00 -> $2.25
--
-- Menu rules encoded here:
--   * Toppings are "whole pizzas only"; slices are "not customizable". Slice
--     variants get allows_modifiers = false so the checkout function refuses a
--     topping on a slice. Toppings attach to every pizza (any whole pie can add
--     any topping).
--   * Ranch and Spicy Ranch are "Extras" (dip cups), not toppings and not
--     whole-only, so they are standalone side items orderable with anything.
--
-- Guarded to run once (skips if the Ranch side already exists) and a no-op on a
-- fresh project with no Daily Dough vendor.

do $$
declare
  dd uuid;
begin
  select id into dd from public.vendors where lower(name) like '%daily dough%' limit 1;
  if dd is null then raise notice 'no Daily Dough vendor'; return; end if;
  if exists (select 1 from public.menu_items where vendor_id = dd and category = 'side' and name = 'Ranch') then
    raise notice 'Daily Dough extras already set — skipping'; return;
  end if;

  -- Slices can't be customised.
  update public.menu_item_variants v
     set allows_modifiers = false
    from public.menu_items mi
   where mi.id = v.menu_item_id and mi.vendor_id = dd and lower(v.label) like '%slice%';

  -- Replace the placeholder toppings with the real list on every pizza.
  delete from public.menu_item_modifiers md
   using public.menu_items mi
   where md.menu_item_id = mi.id and mi.vendor_id = dd;

  insert into public.menu_item_modifiers (menu_item_id, label, price_cents, sort)
  select mi.id, t.label, t.price_cents, t.sort
  from public.menu_items mi
  cross join (values
    ('Mozzarella cheese', 350, 0),
    ('Pepperoni',         350, 1),
    ('Ham',               350, 2),
    ('Bacon',             350, 3),
    ('Chicken',           350, 4),
    ('Red onion',         250, 5),
    ('Green onion',       250, 6),
    ('Jalapeños',         250, 7),
    ('Pineapple',         250, 8),
    ('Grape tomatoes',    250, 9),
    ('Bell pepper',       250, 10),
    ('Mushrooms',         250, 11),
    ('Black olives',      250, 12),
    ('Spinach',           250, 13),
    ('Basil',             250, 14)
  ) as t(label, price_cents, sort)
  where mi.vendor_id = dd and mi.category = 'main';

  -- Real drinks (replace the placeholder set).
  delete from public.menu_items where vendor_id = dd and category = 'drink';
  insert into public.menu_items (vendor_id, name, description, price_cents, category, is_available, default_prep_minutes)
  values
    (dd, 'Coke',         '', 300, 'drink', true, 1),
    (dd, 'Coke Zero',    '', 300, 'drink', true, 1),
    (dd, 'Diet Coke',    '', 300, 'drink', true, 1),
    (dd, 'Dr Pepper',    '', 300, 'drink', true, 1),
    (dd, 'Sprite',       '', 300, 'drink', true, 1),
    (dd, 'Water Bottle', '', 125, 'drink', true, 1);

  -- Dip extras, orderable with anything (whole or slice).
  insert into public.menu_items (vendor_id, name, description, price_cents, category, is_available, default_prep_minutes)
  values
    (dd, 'Ranch',       '3.25 oz cup', 225, 'side', true, 1),
    (dd, 'Spicy Ranch', '3.25 oz cup', 225, 'side', true, 1);

  raise notice 'Daily Dough real extras applied';
end $$;
