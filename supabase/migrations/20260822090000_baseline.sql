-- Bobcat Bites — baseline schema snapshot
--
-- Taken from the live database on 2026-08-22, at the point where the app was
-- already running end to end and had taken real money. Everything here was
-- built directly in the Supabase dashboard over the preceding weeks; this file
-- is the first time any of it exists in git. It is a SNAPSHOT, not a history:
-- it describes the database as it is, not the order it got that way.
--
-- Why this matters: until now the only copy of the RLS policies — the rules
-- deciding who can read a student's phone number or move an order to "ready" —
-- lived in one dashboard. Nobody could review a change to them, and nothing
-- would have flagged a change made by accident.
--
-- READ THIS BEFORE RUNNING IT ANYWHERE
--
-- This file is NOT runnable as-is, on purpose. Three secrets are hardcoded in
-- the live trigger functions, and this repository is public:
--
--   __NOTIFY_SECRET__      the shared secret guarding the notify function's
--                          trigger-only routes
--   __ADMIN_PHONE__        the operator's mobile number
--   __ADMIN_DEVICE_KEYS__  the operator's per-browser push identities
--
-- Substitute real values at apply time. Do not commit them, and do not paste
-- them into a chat window or an issue — that is how the last one got burned.
-- Moving these out of the function bodies and into a secrets table or a
-- database setting is tracked separately; this snapshot records what IS live,
-- including the parts that want fixing.

-- ============================================================
-- Tables
-- ============================================================

create table if not exists public.vendors (
  id                uuid primary key default gen_random_uuid(),
  owner_user_id     uuid references auth.users(id),
  name              text not null,
  description       text,
  contact_phone     text,
  contact_email     text,
  status            text not null default 'pending'
                      check (status in ('pending', 'approved', 'suspended')),
  is_open           boolean not null default false,
  orders_paused     boolean not null default false,
  default_location  text,
  payout_account_id text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  paused_until      timestamptz,
  -- Generated, so the student app can ask "can this truck take a card?"
  -- without the answer ever drifting from whether a Connect account exists.
  accepts_cards     boolean generated always as (payout_account_id is not null) stored
);

-- Students have NO login. A student row is identified by a device_key the
-- browser generates and keeps in localStorage; user_id is here for a future
-- signed-in student and is null for every real row today. See the note under
-- the students policy below — this is why the vendor app cannot read names.
create table if not exists public.students (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid unique references auth.users(id),
  full_name   text,
  phone       text,
  created_at  timestamptz not null default now(),
  device_key  text unique
);

create table if not exists public.menu_items (
  id                   uuid primary key default gen_random_uuid(),
  vendor_id            uuid not null references public.vendors(id) on delete cascade,
  name                 text not null,
  description          text,
  price_cents          integer not null check (price_cents >= 0),
  photo_url            text,
  is_available         boolean not null default true,
  default_prep_minutes integer not null default 10,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table if not exists public.vendor_schedules (
  id          uuid primary key default gen_random_uuid(),
  vendor_id   uuid not null references public.vendors(id) on delete cascade,
  day_of_week integer not null check (day_of_week >= 0 and day_of_week <= 6),
  open_time   time not null,
  close_time  time not null,
  location    text
);

-- 'pending_payment' is the row's state between creating a Stripe Checkout
-- session and the signature-verified webhook coming back. An order that never
-- gets paid stays here; stuck_payments below is how those get noticed.
create table if not exists public.orders (
  id                uuid primary key default gen_random_uuid(),
  student_id        uuid not null references public.students(id),
  vendor_id         uuid not null references public.vendors(id),
  status            text not null default 'placed'
                      check (status in ('pending_payment', 'placed', 'confirmed',
                                        'ready', 'picked_up', 'cancelled')),
  eta_minutes       integer,
  confirmed_at      timestamptz,
  ready_at          timestamptz,
  picked_up_at      timestamptz,
  cancelled_at      timestamptz,
  pickup_code       text,
  subtotal_cents    integer not null default 0,
  total_cents       integer not null default 0,
  payment_intent_id text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- item_name_snapshot and unit_price_cents are copies, not lookups: a receipt
-- has to keep saying what was bought at what price even after the vendor
-- renames the item or changes the price. menu_item_id goes null on delete for
-- the same reason — losing the link must not lose the order.
create table if not exists public.order_items (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid not null references public.orders(id) on delete cascade,
  menu_item_id       uuid references public.menu_items(id) on delete set null,
  item_name_snapshot text not null,
  unit_price_cents   integer not null,
  quantity           integer not null check (quantity > 0),
  notes              text
);

create table if not exists public.order_status_events (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references public.orders(id) on delete cascade,
  status     text not null,
  note       text,
  created_at timestamptz not null default now()
);

-- Exactly one owner per row: a truck's subscription or a student device's,
-- never both and never neither. endpoint is GENERATED from the subscription
-- JSON — never write to it directly — and unique, so re-registering the same
-- browser replaces its row instead of accumulating duplicates.
create table if not exists public.push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  vendor_id    uuid references public.vendors(id) on delete cascade,
  subscription jsonb not null,
  endpoint     text generated always as (subscription ->> 'endpoint') stored unique,
  created_at   timestamptz not null default now(),
  device_key   text,
  constraint push_subscriptions_owner_check check (
    (vendor_id is not null and device_key is null) or
    (vendor_id is null and device_key is not null)
  )
);

-- ============================================================
-- Indexes
-- ============================================================

create index if not exists idx_menu_items_vendor         on public.menu_items          using btree (vendor_id);
create index if not exists idx_order_items_order         on public.order_items         using btree (order_id);
create index if not exists idx_order_status_events_order on public.order_status_events using btree (order_id);
create index if not exists idx_orders_student            on public.orders              using btree (student_id);
create index if not exists idx_orders_vendor_status      on public.orders              using btree (vendor_id, status);
create index if not exists push_subscriptions_device_key_idx
                                                         on public.push_subscriptions  using btree (device_key);

-- ============================================================
-- stuck_payments — the watchdog's view
-- ============================================================
--
-- An order that opened a Checkout session and never came back. Stripe's minimum
-- session lifetime is 30 minutes and cannot be shortened, so 8 minutes is well
-- inside the window where a student has plainly walked away but the session is
-- still technically alive. payment_intent_id is null here specifically: an
-- order that HAS one was paid, and a missing status is then a webhook problem,
-- not an abandonment.
create or replace view public.stuck_payments as
  select o.id as order_id,
         o.pickup_code,
         o.total_cents,
         o.created_at,
         round(extract(epoch from now() - o.created_at) / 60::numeric)::integer as minutes_stuck,
         v.name       as vendor_name,
         s.full_name  as student_name,
         s.phone      as student_phone
    from public.orders o
    join public.vendors v  on v.id = o.vendor_id
    left join public.students s on s.id = o.student_id
   where o.status = 'pending_payment'
     and o.payment_intent_id is null
     and o.created_at < (now() - interval '8 minutes')
   order by o.created_at;

-- ============================================================
-- Row Level Security
-- ============================================================

alter table public.vendors             enable row level security;
alter table public.students            enable row level security;
alter table public.menu_items          enable row level security;
alter table public.vendor_schedules    enable row level security;
alter table public.orders              enable row level security;
alter table public.order_items         enable row level security;
alter table public.order_status_events enable row level security;
alter table public.push_subscriptions  enable row level security;

-- ---- vendors ----
-- Only approved trucks are visible to the public app.
drop policy if exists "Public read approved vendors" on public.vendors;
create policy "Public read approved vendors"
  on public.vendors for select to anon
  using (status = 'approved');

-- NOTE: this WITH CHECK constrains only ownership, not status, so on its own
-- it let a signed-in vendor set their own row to status='approved' and
-- self-approve onto the public listing. RLS cannot express the fix — WITH
-- CHECK sees only the new row, never the old one. It is closed by column
-- privileges in 20260822093000_lock_vendor_status.sql, which must be applied
-- alongside this file.
drop policy if exists "Vendor owner manages own vendor row" on public.vendors;
create policy "Vendor owner manages own vendor row"
  on public.vendors for all to authenticated
  using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());

-- ---- students ----
-- The ONLY policy on this table. Students have no login, so auth.uid() is null
-- for every student session and this predicate is never true for them. In
-- practice that means: student rows are written and read solely by the api
-- edge function on the service role, and the vendor app's
-- orders -> students(full_name, phone) join returns nothing, so every order
-- shows as "Student" with no name. That is UNDER-exposure, not a leak — but it
-- is a real gap in the vendor's view and is tracked separately.
drop policy if exists "Student manages own profile" on public.students;
create policy "Student manages own profile"
  on public.students for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---- menu_items ----
drop policy if exists "Public read available menu items" on public.menu_items;
create policy "Public read available menu items"
  on public.menu_items for select
  using (is_available = true and exists (
    select 1 from public.vendors v where v.id = menu_items.vendor_id and v.status = 'approved'
  ));

drop policy if exists "Vendor owner manages own menu items" on public.menu_items;
create policy "Vendor owner manages own menu items"
  on public.menu_items for all to authenticated
  using (exists (
    select 1 from public.vendors v where v.id = menu_items.vendor_id and v.owner_user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.vendors v where v.id = menu_items.vendor_id and v.owner_user_id = auth.uid()
  ));

-- ---- vendor_schedules ----
drop policy if exists "Public read vendor schedules" on public.vendor_schedules;
create policy "Public read vendor schedules"
  on public.vendor_schedules for select
  using (exists (
    select 1 from public.vendors v where v.id = vendor_schedules.vendor_id and v.status = 'approved'
  ));

drop policy if exists "Vendor owner manages own schedule" on public.vendor_schedules;
create policy "Vendor owner manages own schedule"
  on public.vendor_schedules for all
  using (exists (
    select 1 from public.vendors v where v.id = vendor_schedules.vendor_id and v.owner_user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.vendors v where v.id = vendor_schedules.vendor_id and v.owner_user_id = auth.uid()
  ));

-- ---- orders ----
-- Both sides of an order can read it; only the vendor can move it along.
-- Students never update an order directly — cancellation and refunds go
-- through the stripe edge function so the money and the row change together.
drop policy if exists "Student reads own orders" on public.orders;
create policy "Student reads own orders"
  on public.orders for select
  using (exists (select 1 from public.students s where s.id = orders.student_id and s.user_id = auth.uid()));

drop policy if exists "Student creates own orders" on public.orders;
create policy "Student creates own orders"
  on public.orders for insert
  with check (exists (select 1 from public.students s where s.id = orders.student_id and s.user_id = auth.uid()));

drop policy if exists "Vendor reads own orders" on public.orders;
create policy "Vendor reads own orders"
  on public.orders for select
  using (exists (select 1 from public.vendors v where v.id = orders.vendor_id and v.owner_user_id = auth.uid()));

drop policy if exists "Vendor updates own orders" on public.orders;
create policy "Vendor updates own orders"
  on public.orders for update
  using (exists (select 1 from public.vendors v where v.id = orders.vendor_id and v.owner_user_id = auth.uid()));

-- ---- order_items / order_status_events ----
-- Visible to whoever is on the order, from either side.
drop policy if exists "Order items visible to order participants" on public.order_items;
create policy "Order items visible to order participants"
  on public.order_items for select
  using (exists (
    select 1 from public.orders o
      left join public.students s on s.id = o.student_id
      left join public.vendors  v on v.id = o.vendor_id
     where o.id = order_items.order_id
       and (s.user_id = auth.uid() or v.owner_user_id = auth.uid())
  ));

drop policy if exists "Student creates own order items" on public.order_items;
create policy "Student creates own order items"
  on public.order_items for insert
  with check (exists (
    select 1 from public.orders o join public.students s on s.id = o.student_id
     where o.id = order_items.order_id and s.user_id = auth.uid()
  ));

drop policy if exists "Status events visible to order participants" on public.order_status_events;
create policy "Status events visible to order participants"
  on public.order_status_events for select
  using (exists (
    select 1 from public.orders o
      left join public.students s on s.id = o.student_id
      left join public.vendors  v on v.id = o.vendor_id
     where o.id = order_status_events.order_id
       and (s.user_id = auth.uid() or v.owner_user_id = auth.uid())
  ));

drop policy if exists "Vendor logs status events on own orders" on public.order_status_events;
create policy "Vendor logs status events on own orders"
  on public.order_status_events for insert
  with check (exists (
    select 1 from public.orders o join public.vendors v on v.id = o.vendor_id
     where o.id = order_status_events.order_id and v.owner_user_id = auth.uid()
  ));

-- ---- push_subscriptions ----
-- Only the vendor half is expressible in RLS, because it is the only half with
-- a logged-in identity to check. Student rows (device_key) carry no such proof
-- and are written exclusively by the notify function on the service role, via
-- POST /notify/subscribe. That endpoint refuses a vendor_id outright — the
-- policy below is the only way a truck's subscription can be created, because
-- it is the only path that can actually prove ownership.
drop policy if exists "Vendor owner manages own push subscriptions" on public.push_subscriptions;
create policy "Vendor owner manages own push subscriptions"
  on public.push_subscriptions for all
  using (exists (
    select 1 from public.vendors v where v.id = push_subscriptions.vendor_id and v.owner_user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.vendors v where v.id = push_subscriptions.vendor_id and v.owner_user_id = auth.uid()
  ));

-- ============================================================
-- Trigger functions
-- ============================================================
--
-- These call the notify edge function over pg_net. The x-notify-secret value
-- is REDACTED here; see the header.

-- Fires the vendor's "new order" push. The status guard is the whole point:
-- an order is inserted as 'pending_payment' and only becomes 'placed' when the
-- signature-verified Stripe webhook says the money arrived. Without this guard
-- a truck would start cooking for an order nobody paid for. The second guard
-- covers Stripe redelivering the same webhook — it retries until it gets a 2xx.
create or replace function public.notify_new_order()
returns trigger
language plpgsql
set search_path to 'public', 'net'
as $function$
begin
  if new.status <> 'placed' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'placed' then
    return new;
  end if;

  perform net.http_post(
    url := 'https://gqwihtfjmxqxkzssnsrk.supabase.co/functions/v1/notify',
    headers := jsonb_build_object('Content-Type','application/json','x-notify-secret','__NOTIFY_SECRET__'),
    body := jsonb_build_object('order_id',new.id,'vendor_id',new.vendor_id,'total_cents',new.total_cents,'pickup_code',new.pickup_code)
  );
  return new;
end;
$function$;

-- SECURITY DEFINER because it reads students.phone, which RLS otherwise hides
-- from everyone (see the students policy above). This is how the student's
-- "confirmed" and "ready" messages find a number to text.
create or replace function public.notify_status_change()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare cust_phone text;
begin
  if new.status is distinct from old.status then
    select phone into cust_phone from public.students where id = new.student_id;
    perform net.http_post(
      url := 'https://gqwihtfjmxqxkzssnsrk.supabase.co/functions/v1/notify',
      headers := jsonb_build_object('Content-Type','application/json','x-notify-secret','__NOTIFY_SECRET__'),
      body := jsonb_build_object('event','status_change','order_id',new.id,'vendor_id',new.vendor_id,
        'new_status',new.status,'pickup_code',new.pickup_code,'eta_minutes',new.eta_minutes,'customer_phone',cust_phone)
    );
  end if;
  return new;
end
$function$;

-- The stuck-payment watchdog. Run on a schedule; alerts the operator only.
-- Web push is the primary channel here, not SMS: Twilio accepts the message and
-- returns 201, but US carriers drop it while A2P 10DLC registration is
-- incomplete — so an SMS-only alert would be silently lost, which is the exact
-- failure this watchdog exists to catch.
--
-- device_key is per-origin, so moving the app to a new domain mints a new one.
-- Re-subscribe and add the new key here or the alert goes nowhere.
create or replace function public.alert_stuck_payments()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  stuck_count int;
  stuck_total int;
  oldest_min  int;
  admin_phone text   := '__ADMIN_PHONE__';
  admin_keys  text[] := array['__ADMIN_DEVICE_KEYS__'];
begin
  select count(*), coalesce(sum(total_cents),0), coalesce(max(minutes_stuck),0)
    into stuck_count, stuck_total, oldest_min
  from stuck_payments;

  if stuck_count = 0 then
    return;
  end if;

  perform net.http_post(
    url := 'https://gqwihtfjmxqxkzssnsrk.supabase.co/functions/v1/notify',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-notify-secret','__NOTIFY_SECRET__'
    ),
    body := jsonb_build_object(
      'event','admin_alert',
      'customer_phone', admin_phone,
      'admin_device_keys', to_jsonb(admin_keys),
      'message', format(
        '%s order(s) stuck awaiting payment ($%s total, oldest %s min). Check Stripe for an unrecorded charge.',
        stuck_count, to_char(stuck_total/100.0,'FM999990.00'), oldest_min
      )
    )
  );
end;
$function$;

-- ============================================================
-- Triggers
-- ============================================================

drop trigger if exists trg_notify_new_order on public.orders;
create trigger trg_notify_new_order
  after insert or update of status on public.orders
  for each row execute function public.notify_new_order();

drop trigger if exists trg_notify_status_change on public.orders;
create trigger trg_notify_status_change
  after update of status on public.orders
  for each row execute function public.notify_status_change();
