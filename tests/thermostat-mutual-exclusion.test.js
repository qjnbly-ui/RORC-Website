const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const migrationPath = path.join(
  root,
  "supabase",
  "migrations",
  "20260809215902_enforce_heat_ac_mutual_exclusion.sql"
);

test("database permits only one active thermostat runtime across heat and AC", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert.match(sql, /create unique index if not exists idx_heater_use_entries_one_active_thermostat/i);
  assert.match(sql, /on public\.heater_use_entries \(\(true\)\)/i);
  assert.match(sql, /where end_at is null\s+and turn_heater_on = 'On'::public\.heater_state/i);
  assert.match(sql, /drop index if exists public\.idx_heater_use_entries_one_active_per_system/i);
});

test("app blocks either thermostat when any runtime is already active", () => {
  const source = fs.readFileSync(path.join(root, "RORC App", "app.js"), "utf8");

  assert.match(source, /const existingRuntime = activeHeaterEntry\(\)/);
  assert.match(source, /thermostatRuntimeConflictError\(systemType, existingRuntime\.systemType\)/);
  assert.match(source, /Turn it off before starting/);
  assert.match(source, /idx_heater_use_entries_one_active_thermostat/);
});
