# RORC App

This folder is the starting point for the next RORC application.

## Why start as a web app
- Fast to build and test in any browser
- Easy to deploy and share for feedback
- Can later be wrapped into mobile apps (Capacitor/React Native/etc.)

## Current structure
- `index.html` - app shell
- `app.css` - styles and layout tokens
- `app.js` - simple client-side routing + starter modules
- `app.config.example.js` - optional standalone Supabase config template

## Supabase data
The website version loads `/scripts/rorc-supabase-client.js`, so it shares the same Supabase Auth session as the member dashboard. If a member opens the app from the dashboard, the app should open without a second login prompt.

For standalone testing only, copy `app.config.example.js` to `app.config.js`, include it before `app.js`, and set:

```js
window.RORC_SUPABASE_CONFIG = {
  supabaseUrl: "https://YOUR_PROJECT_REF.supabase.co",
  supabaseAnonKey: "YOUR_SUPABASE_ANON_KEY"
};
```

`app.config.js` is ignored by git. The app loads `account_member_profiles`, `timesheet_entries`, `heater_use_entries_with_duration`, `heater_use_group_members`, and `billing_line_items`. If there is no active Supabase session, the app shows its login screen instead of exposing app data.

## Supabase Auth user import
After `public.sync_current_memberships_to_app_tables()` has populated `account_members`, create/link Supabase Auth users from the server side:

```sh
SUPABASE_URL="https://YOUR_PROJECT_REF.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="YOUR_SERVICE_ROLE_KEY" \
npm run rorc:create-auth-users
```

That command is a dry run. To actually create/link users:

```sh
SUPABASE_URL="https://YOUR_PROJECT_REF.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="YOUR_SERVICE_ROLE_KEY" \
npm run rorc:create-auth-users -- --apply
```

The script creates one Auth user per unique valid email and links it back to `account_members.auth_user_id`. Missing emails and duplicate emails are skipped safely. If a shared account has duplicate emails, the billing owner is the Auth user for that shared account.

Re-running the script also syncs Auth metadata for already-linked users, including `display_name`, `name`, `full_name`, `member_name`, and `phone_number`. Phone numbers stay in metadata by default instead of the Supabase Auth `phone` login column.

Do not put the service-role key in `app.config.js` or any browser file.

## Suggested next build order
1. Replace form Save buttons with Supabase inserts/RPC calls
2. Voice Monkey / heater automation worker
3. Tighten role-based navigation and RLS policies
4. Mobile packaging once web MVP is stable

## Run locally
Open `index.html` directly, or run any local static server from the repo root.
