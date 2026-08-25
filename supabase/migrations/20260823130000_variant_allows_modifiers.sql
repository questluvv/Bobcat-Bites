-- Per-size control over whether toppings can be added
--
-- Daily Dough's menu: "Additional Toppings (whole pizzas only)" and "Slices …
-- Not customizable." Modifiers hang off the menu_item (the pizza), not the
-- variant, so without this flag the server would happily add a topping to a
-- slice. This lets a specific size opt out of modifiers; the checkout function
-- reads it and rejects a topping on a size that disallows them.
--
-- Default true so every existing item and every flat item is unchanged.

alter table public.menu_item_variants
  add column if not exists allows_modifiers boolean not null default true;
