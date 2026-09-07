# Tracker-Board

Mobile-first target tracker for a small branch team.

## Current MVP

- Admin and employee views
- Admin dashboard tab with graphical team and individual performance
- Employee Management tab for create, reset PIN, and delete actions
- First-run admin setup
- Only one admin account
- Employee ID + 4-digit PIN login
- PIN reset with Employee ID, old PIN, and new PIN
- Admin-assisted employee PIN reset
- Admin employee delete with confirmation
- Monthly target name and amount setting
- Employee entry with numeric-only amount
- Admin ID must be alphanumeric and include at least one letter
- Employee IDs can be numeric-only or alphanumeric
- Progress percentages and visual performance bars
- Team leaderboard for competitive visibility
- Six-month month selector
- CSV export for admin
- Browser-storage local mode when Supabase env vars are not set

## Run Locally

```bash
npm install
npm run dev
```

## Supabase Setup

1. Create a Supabase project.
2. Run `supabase/schema.sql` in the Supabase SQL editor.
3. Create users in Supabase Auth.
4. Insert matching rows into `public.profiles`.
5. Store PINs through `public.set_profile_pin(profile_id, '1234')` so PINs are hashed.
6. Copy `.env.example` to `.env.local`.
7. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.

The current UI runs in local browser-storage mode until live Supabase data wiring is enabled. For production Employee ID + PIN auth, verification should happen in a Supabase Edge Function or server route so PIN hashes are never exposed to the browser. PIN reset can use `public.reset_profile_pin(employee_code, old_pin, new_pin)` from that server-side layer.

If an employee forgets their PIN entirely, an admin can reset it through `public.admin_reset_profile_pin(employee_code, new_pin)` after verifying the employee offline. If the admin forgets their PIN, reset it out-of-band from Supabase SQL or a private maintenance script using `public.set_profile_pin(admin_profile_id, '1234')`; do not expose admin emergency reset in the public app.

Admin employee delete should use a double-confirmation UI and then deactivate the employee through `public.admin_delete_employee(employee_code)` so historical data remains available.

## Vercel Setup

1. Push this project to GitHub.
2. Import the repo in Vercel.
3. Add the same Supabase environment variables in Vercel project settings.
4. Deploy.

## Multiple monthly targets

Admins (including the branch manager account) can use **Add target** beside a member to assign additional named targets for the selected month. Each target has its own Save button. Existing targets remain editable, including their names. Employee progress, charts, leaderboard and summary exports use the sum of the member's monthly targets; recovery entries count once against that total. Excel also includes a Targets sheet with individual assignments.

For an existing Supabase installation, run `supabase/multiple-targets.sql` in the SQL editor **before deploying the updated frontend**. This preserves existing records, removes the one-target-per-month constraint, updates the snapshot and progress view, and installs the ID-based save RPC. The previous frontend's target-save RPC is retired, so deploy the frontend immediately afterward. New installations use the updated `supabase/schema.sql`.
