const assert = require("node:assert/strict");
const test = require("node:test");

const heaterOffModulePath = require.resolve("../api/heater-off-sequence.js");
const ecobeeClientPath = require.resolve("../api/_ecobee-client.js");
const occupancyStatePath = require.resolve("../api/_facility-occupancy-state.js");

function mockModule(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports
  };
}

function prepareEnvironment() {
  const prior = {
    fetch: global.fetch,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    heatId: process.env.ECOBEE_HEATER_THERMOSTAT_ID,
    acId: process.env.ECOBEE_AC_THERMOSTAT_ID
  };
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  process.env.ECOBEE_HEATER_THERMOSTAT_ID = "heat-thermostat";
  process.env.ECOBEE_AC_THERMOSTAT_ID = "ac-thermostat";
  return prior;
}

function restoreEnvironment(prior) {
  global.fetch = prior.fetch;
  if (prior.serviceKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = prior.serviceKey;
  if (prior.heatId === undefined) delete process.env.ECOBEE_HEATER_THERMOSTAT_ID;
  else process.env.ECOBEE_HEATER_THERMOSTAT_ID = prior.heatId;
  if (prior.acId === undefined) delete process.env.ECOBEE_AC_THERMOSTAT_ID;
  else process.env.ECOBEE_AC_THERMOSTAT_ID = prior.acId;
  delete require.cache[heaterOffModulePath];
  delete require.cache[ecobeeClientPath];
  delete require.cache[occupancyStatePath];
}

test("AC shutdown restores the circulation fan after closure when the facility is occupied", async () => {
  const prior = prepareEnvironment();
  const events = [];

  mockModule(ecobeeClientPath, {
    resumeEcobeeProgram: async () => events.push("resume"),
    setEcobeeHvacMode: async () => events.push("mode-off"),
    setEcobeeFanHold: async (options) => events.push(`fan-on:${options.thermostatId}`)
  });
  mockModule(occupancyStatePath, {
    hasCurrentFacilityOccupancy: async () => {
      events.push("occupancy-check");
      return true;
    }
  });
  global.fetch = async (url, options = {}) => {
    const requestUrl = String(url);
    if (requestUrl.includes("heater_use_entries?select=")) {
      return {
        ok: true,
        json: async () => [{
          id: "ac-runtime",
          system_type: "ac",
          responsible_member_id: "member-1",
          group_pay: false,
          set_a_timer: false,
          turn_heater_on: "On",
          start_at: "2026-08-09T18:00:00.000Z",
          end_at: null
        }]
      };
    }
    if (requestUrl.includes("heater_use_entries?") && options.method === "PATCH") {
      events.push("close-record");
      return { ok: true, json: async () => [{ id: "ac-runtime" }] };
    }
    if (requestUrl.includes("automation_settings")) {
      const isFanSettings = requestUrl.includes("gym_lights_on");
      return {
        ok: true,
        json: async () => [{
          config: isFanSettings
            ? { enabled: true, ac_fan_enabled: true, ac_thermostat_id: "configured-ac" }
            : { enabled: false }
        }]
      };
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  };

  delete require.cache[heaterOffModulePath];
  try {
    const { executeHeaterOff } = require(heaterOffModulePath);
    const result = await executeHeaterOff({
      requestedSystemType: "ac",
      heaterUseEntryId: "ac-runtime",
      closeEntry: true,
      endAt: "2026-08-09T19:00:00.000Z"
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.fanReconciliation, { restored: true, occupied: true, warnings: [] });
    assert.deepEqual(events, [
      "resume",
      "mode-off",
      "close-record",
      "occupancy-check",
      "fan-on:configured-ac"
    ]);
  } finally {
    restoreEnvironment(prior);
  }
});

test("AC shutdown leaves the fan automatic when the facility is empty", async () => {
  const prior = prepareEnvironment();
  let fanHoldCount = 0;
  mockModule(ecobeeClientPath, {
    resumeEcobeeProgram: async () => {},
    setEcobeeHvacMode: async () => {},
    setEcobeeFanHold: async () => { fanHoldCount += 1; }
  });
  mockModule(occupancyStatePath, {
    hasCurrentFacilityOccupancy: async () => false
  });
  global.fetch = async (url) => {
    if (String(url).includes("automation_settings")) {
      return { ok: true, json: async () => [{ config: { enabled: true, ac_fan_enabled: true } }] };
    }
    throw new Error(`Unexpected request: ${String(url)}`);
  };

  delete require.cache[heaterOffModulePath];
  try {
    const { reconcileAcFanAfterShutdown } = require(heaterOffModulePath);
    const result = await reconcileAcFanAfterShutdown();
    assert.deepEqual(result, { skipped: true, reason: "facility_empty", occupied: false, warnings: [] });
    assert.equal(fanHoldCount, 0);
  } finally {
    restoreEnvironment(prior);
  }
});

test("facility occupancy lookup uses only open timesheet rows", async () => {
  delete require.cache[occupancyStatePath];
  const { hasCurrentFacilityOccupancy } = require(occupancyStatePath);
  let requestedUrl = "";
  const occupied = await hasCurrentFacilityOccupancy({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-key",
    fetcher: async (url) => {
      requestedUrl = String(url);
      return { ok: true, json: async () => [{ id: "open-entry" }] };
    }
  });

  assert.equal(occupied, true);
  assert.match(requestedUrl, /timesheet_entries\?/);
  assert.match(requestedUrl, /signed_out_at=is\.null/);
  assert.match(requestedUrl, /limit=1/);
});
