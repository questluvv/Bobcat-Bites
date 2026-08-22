-- Stop vendors approving themselves onto the student app
--
-- "Vendor owner manages own vendor row" is FOR ALL with
-- WITH CHECK (owner_user_id = auth.uid()). That constrains WHOSE row you may
-- write, but says nothing about WHAT you may write into it. Every column was
-- fair game, so a signed-in vendor could set their own status to 'approved'
-- and appear on the student app's truck list without anyone approving them.
-- They could also point payout_account_id at a different Stripe account.
--
-- RLS alone cannot fix this. WITH CHECK sees only the NEW row, never the old
-- one, so there is no way to write "status must not change" as a policy. The
-- fix is column privileges, which compose with RLS: RLS still decides WHICH
-- row, and these decide WHICH COLUMNS.
--
-- Postgres treats a table-level grant as covering every column, so the
-- table-level grant has to come off before a column list means anything.
-- That is why the revoke comes first rather than being a redundant no-op.
--
-- Approval is unaffected: the admin app calls admin_set_status on the api edge
-- function, which runs on the service role and is PIN-gated. service_role
-- grants are deliberately untouched here. Likewise payout_account_id is still
-- written by the stripe function during Connect onboarding.
--
-- The allowed lists below are exactly what vendor_app.html writes today:
--   insert  -> the signup form's record
--   update  -> saveTruck() and updateVendor() (open/closed, pause, timer)
-- Adding a field to either form means adding it here too, or the save fails.

revoke update on public.vendors from authenticated, anon;
grant  update (name, description, contact_phone, default_location,
               is_open, orders_paused, paused_until, updated_at)
  on public.vendors to authenticated;

-- owner_user_id is insertable but not updatable: a vendor claims their row at
-- signup (RLS forces it to equal auth.uid()) and cannot reassign it afterwards.
-- status is absent from both lists, so a new row can only take the column
-- default, which is 'pending'.
revoke insert on public.vendors from authenticated, anon;
grant  insert (owner_user_id, name, description, contact_phone,
               contact_email, default_location)
  on public.vendors to authenticated;
