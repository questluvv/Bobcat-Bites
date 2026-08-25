-- Sauces as a distinct kind of modifier, and Daily Dough's free white-sauce swap
--
-- A modifier was always a paid topping. Daily Dough also offers a white-sauce
-- swap: free, whole-pizzas-only, and it does NOT count toward the three-topping
-- limit. Rather than fake that with a $0 topping (which would still count), a
-- modifier now has a kind: 'topping' (default, what everything already is) or
-- 'sauce'. The checkout function counts only toppings toward the cap and prices
-- sauces like anything else (white sauce is simply 0).
--
-- Whole-only comes for free: modifiers of any kind are already refused on a
-- variant whose allows_modifiers is false, so a slice can't take white sauce and
-- stays red. Default red needs no row — it's the absence of a sauce modifier.

alter table public.menu_item_modifiers
  add column if not exists kind text not null default 'topping'
    check (kind in ('topping', 'sauce'));

-- Seed the white-sauce swap on every Daily Dough pizza (guarded to run once).
do $$
declare dd uuid;
begin
  select id into dd from public.vendors where lower(name) like '%daily dough%' limit 1;
  if dd is null then return; end if;
  if exists (
    select 1 from public.menu_item_modifiers md
    join public.menu_items mi on mi.id = md.menu_item_id
    where mi.vendor_id = dd and md.kind = 'sauce'
  ) then return; end if;

  insert into public.menu_item_modifiers (menu_item_id, label, price_cents, sort, kind)
  select mi.id, 'White sauce', 0, -1, 'sauce'
  from public.menu_items mi
  where mi.vendor_id = dd and mi.category = 'main';
end $$;
