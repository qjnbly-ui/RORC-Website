const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const migrationPath = path.join(
  root,
  "supabase",
  "migrations",
  "20260809215015_prevent_overlapping_thermostat_runtimes.sql"
);

test("database permits only one open On runtime for each thermostat system", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert.match(sql, /create unique index if not exists idx_heater_use_entries_one_active_per_system/i);
  assert.match(sql, /on public\.heater_use_entries \(system_type\)/i);
  assert.match(sql, /where end_at is null\s+and turn_heater_on = 'On'::public\.heater_state/i);
  assert.match(sql, /group by system_type\s+having count\(\*\) > 1/i);
});

test("app preflights an active runtime and explains a database race clearly", () => {
  const source = fs.readFileSync(path.join(root, "RORC App", "app.js"), "utf8");

  assert.match(source, /const existingRuntime = activeHeaterEntry\(\)/);
  assert.match(source, /code === "23505"/);
  assert.match(source, /idx_heater_use_entries_one_active_per_system/);
  assert.match(source, /already has an active runtime/);
});
