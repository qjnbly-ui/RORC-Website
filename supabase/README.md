# Database SQL files

## Migration history

Keep the timestamped files in `migrations/`, including migrations already applied to production. Tests and database rebuilds use these files.

Compare the live database migration history before applying anything. Several recorded production versions differ from the timestamps of the corresponding checked-in files. A filename difference alone does not mean a change needs to be applied again.

## Setup and maintenance

`rorc_app_schema.sql` and the remaining standalone SQL files preserve the older setup scripts and feature additions. These are not a replacement for the current migration history, and should not be replayed indiscriminately against production.

`kiosk_sync_realtime_and_heater_security_verification.sql` is a verification utility. `clear_stuck_thermostat_state.sql` is a manual maintenance utility that changes thermostat records; it is not a migration to apply automatically.

## Removed obsolete repair scripts

- `fix_heater_rls_recursion.sql`: superseded by `migrations/20260808105304_kiosk_sync_realtime_and_heater_security.sql`, which replaces the old public access helpers with private policy helpers.
- `allow_admin_thermostat_end_time_corrections.sql`: superseded by the same applied security migration's private thermostat update protection.
- `fix_thermostat_records_view.sql`: duplicated column, index, and duration-view setup retained in `rorc_app_schema.sql`; the repaired view already exists in production.

These files remain recoverable from Git history. Removing them does not change the database, its applied migration records, or application behavior.
