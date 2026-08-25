-- A per-size note, and Daily Dough's slice disclaimer
--
-- Some sizes carry a caveat the student should see before ordering. Daily
-- Dough's slices are made ahead, heated when the student arrives, and only sold
-- 11:30 AM - 8:00 PM. This is display-only text on the variant; it does not
-- affect pricing or gate ordering (the hours are a heads-up, not enforced).
-- Nullable so every other size shows nothing.

alter table public.menu_item_variants
  add column if not exists note text;

do $$
declare dd uuid;
begin
  select id into dd from public.vendors where lower(name) like '%daily dough%' limit 1;
  if dd is null then return; end if;
  update public.menu_item_variants v
     set note = 'Heated up fresh when you arrive. Slices are served 11:30 AM–8:00 PM, while supplies last.'
    from public.menu_items mi
   where mi.id = v.menu_item_id and mi.vendor_id = dd and lower(v.label) like '%slice%';
end $$;
