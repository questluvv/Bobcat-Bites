-- Menu items get sizes (variants), toppings (modifiers) and a category
--
-- Daily Dough listed each pizza twice — one menu_items row for the whole, one
-- for the slice — which is cluttered and gets worse with every item. This adds
-- the structure to list a pizza ONCE and let the student pick a size, add
-- toppings, and tack on a drink, without any of it inventing a price the client
-- gets to choose (see the stripe function's create_checkout, which recomputes
-- every unit price from these rows).
--
-- Backward compatible on purpose: an item with no variants behaves exactly as
-- it does today, charging price_cents. Every other vendor's flat menu is
-- untouched.

-- ---- category on menu_items --------------------------------------------------
-- 'main'  a normal orderable item / pizza (the default; every existing row)
-- 'drink' rendered as a pill row at the top of the student menu, and offered as
--         an upsell inside a pizza's detail sheet
-- 'side'  reserved for later; renders as a card like 'main'
alter table public.menu_items
  add column if not exists category text not null default 'main'
    check (category in ('main', 'drink', 'side'));

-- ---- variants: the sizes of one item ----------------------------------------
-- A pizza has 1..n variants ("18\" Whole", "Slice"); a flat item has 0. When an
-- item has variants, the server REQUIRES one to be chosen and prices from it,
-- ignoring menu_items.price_cents. price_cents on the variant is the real price
-- of that size.
create table if not exists public.menu_item_variants (
  id           uuid primary key default gen_random_uuid(),
  menu_item_id uuid not null references public.menu_items(id) on delete cascade,
  label        text not null,
  price_cents  integer not null check (price_cents >= 0),
  prep_minutes integer,
  sort         integer not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists idx_menu_item_variants_item on public.menu_item_variants (menu_item_id);

-- ---- modifiers: optional add-ons (toppings) ---------------------------------
-- 0..n per item. Each adds its price_cents to the chosen unit. The server
-- rejects a modifier that does not belong to the item being ordered, so a
-- cheap item cannot borrow another item's (or another truck's) add-on.
create table if not exists public.menu_item_modifiers (
  id           uuid primary key default gen_random_uuid(),
  menu_item_id uuid not null references public.menu_items(id) on delete cascade,
  label        text not null,
  price_cents  integer not null check (price_cents >= 0),
  sort         integer not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists idx_menu_item_modifiers_item on public.menu_item_modifiers (menu_item_id);

-- ---- RLS: mirror menu_items -------------------------------------------------
-- Read: public, but only for a variant/modifier whose parent item is available
-- and whose truck is approved — the same gate menu_items uses, applied through
-- the parent. Write: the vendor who owns the parent item.
alter table public.menu_item_variants  enable row level security;
alter table public.menu_item_modifiers enable row level security;

drop policy if exists "Public read variants of available items" on public.menu_item_variants;
create policy "Public read variants of available items"
  on public.menu_item_variants for select
  using (exists (
    select 1 from public.menu_items mi join public.vendors v on v.id = mi.vendor_id
     where mi.id = menu_item_variants.menu_item_id
       and mi.is_available = true and v.status = 'approved'
  ));

drop policy if exists "Vendor owner manages own variants" on public.menu_item_variants;
create policy "Vendor owner manages own variants"
  on public.menu_item_variants for all to authenticated
  using (exists (
    select 1 from public.menu_items mi join public.vendors v on v.id = mi.vendor_id
     where mi.id = menu_item_variants.menu_item_id and v.owner_user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.menu_items mi join public.vendors v on v.id = mi.vendor_id
     where mi.id = menu_item_variants.menu_item_id and v.owner_user_id = auth.uid()
  ));

drop policy if exists "Public read modifiers of available items" on public.menu_item_modifiers;
create policy "Public read modifiers of available items"
  on public.menu_item_modifiers for select
  using (exists (
    select 1 from public.menu_items mi join public.vendors v on v.id = mi.vendor_id
     where mi.id = menu_item_modifiers.menu_item_id
       and mi.is_available = true and v.status = 'approved'
  ));

drop policy if exists "Vendor owner manages own modifiers" on public.menu_item_modifiers;
create policy "Vendor owner manages own modifiers"
  on public.menu_item_modifiers for all to authenticated
  using (exists (
    select 1 from public.menu_items mi join public.vendors v on v.id = mi.vendor_id
     where mi.id = menu_item_modifiers.menu_item_id and v.owner_user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.menu_items mi join public.vendors v on v.id = mi.vendor_id
     where mi.id = menu_item_modifiers.menu_item_id and v.owner_user_id = auth.uid()
  ));

-- Match the wide table grants Supabase's default privileges already give
-- menu_items; RLS above is what actually constrains access. Explicit here so a
-- fresh project applying this file lands in the same place without relying on
-- default-privilege configuration.
grant select, insert, update, delete on public.menu_item_variants  to anon, authenticated, service_role;
grant select, insert, update, delete on public.menu_item_modifiers to anon, authenticated, service_role;
