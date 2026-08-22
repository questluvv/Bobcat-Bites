# Database schema

Until 2026-08-22 the entire database — tables, row-level security policies,
triggers, the stuck-payment watchdog — existed only in the Supabase dashboard.
Nothing was in git. That meant the rules deciding who can read a student's
phone number or move an order to "ready" could not be reviewed, diffed, or
restored, and a change made by accident would have left no trace.

`20260822090000_baseline.sql` is a snapshot of the live database as it stood on
2026-08-22, at a point where the app was already running end to end and had
taken real money. It is a snapshot, not a history: it describes the database as
it is, not the order it got that way. Changes from here on should be new files
in this directory, so the diff is the record.

## The file is deliberately not runnable as-is

Three secrets are hardcoded in the live trigger function bodies, and this
repository is public. They appear in the snapshot as placeholders:

| Placeholder | What it is |
|---|---|
| `__NOTIFY_SECRET__` | shared secret guarding the notify function's trigger-only routes |
| `__ADMIN_PHONE__` | the operator's mobile number |
| `__ADMIN_DEVICE_KEYS__` | the operator's per-browser push identities |

Substitute real values at apply time. Do not commit them and do not paste them
into a chat window or an issue.

That those secrets live in function bodies at all is a known weakness, recorded
rather than quietly fixed: this file's job is to say what IS live. Moving them
into a secrets table or a database setting is separate work with its own diff.

## Two live findings recorded in the snapshot

Both are commented at the policy they concern. Neither is fixed here, because
a baseline that also changes things is not a baseline.

**Vendors can self-approve.** `"Vendor owner manages own vendor row"` is
`FOR ALL` with `WITH CHECK (owner_user_id = auth.uid())`. That constrains
ownership but not `status`, so a signed-in vendor can insert or update their own
row with `status = 'approved'` and put themselves on the public listing.

**The vendor app cannot read customer names.** `students` has exactly one
policy, `user_id = auth.uid()`. Students have no login, so `auth.uid()` is null
in every student session and that predicate is never true for them. Student rows
are therefore written and read solely by the `api` edge function on the service
role, and the vendor app's `orders -> students(full_name, phone)` join returns
nothing — every order shows as "Student" with no name attached. This is
under-exposure, not a leak, but it is a real gap in what the vendor sees.

## Applying it

The baseline targets a fresh project. Policies are wrapped in
`drop policy if exists` so the file can be re-applied without failing halfway —
a baseline you cannot re-run is one you discover is broken during a restore.

`supabase/` is listed in `.assetsignore` and in the `_config.yml` exclude list,
so nothing here is ever served from bobcat-bites.com.
