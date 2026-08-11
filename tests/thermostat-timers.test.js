const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const timerModulePath = require.resolve("../api/dispatch-thermostat-timers.js");
const heaterOffModulePath = require.resolve("../api/heater-off-sequence.js");
const ecobeeClientPath = require.resolve("../api/_ecobee-client.js");

const {
  authorized,
  dispatchDueTimers,
  isTimerDue,
  timerSchedule
} = require(timerModulePath);

function mockModule(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports
  };
}

test("thermostat timer cron requires the exact bearer secret", () => {
  const prior = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "timer-cron-secret";
  try {
    assert.equal(authorized({ headers: { authorization: "Bearer timer-cron-secret" } }), true);
    assert.equal(authorized({ headers: { authorization: "Bearer wrong" } }), false);
    assert.equal(authorized({ headers: {} }), false);
  } finally {
    if (prior === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prior;
  }
});

test("timer due checks use facility time and handle crossing midnight", () => {
  const daytime = {
    start_at: "2026-08-09T18:00:00.000Z",
    timer_stop: "11:15:00"
  };
  assert.equal(timerSchedule(daytime).key, "2026-08-09T11:15");
  assert.equal(timerSchedule(daytime).durationMinutes, 15);
  assert.equal(isTimerDue(daytime, new Date("2026-08-09T18:14:59.000Z")), false);
  assert.equal(isTimerDue(daytime, new Date("2026-08-09T18:15:00.000Z")), true);

  const overnight = {
    start_at: "2026-08-10T06:50:00.000Z",
    timer_stop: "00:05:00"
  };
  assert.equal(timerSchedule(overnight).key, "2026-08-10T00:05");
  assert.equal(timerSchedule(overnight).durationMinutes, 15);
  assert.equal(isTimerDue(overnight, new Date("2026-08-10T07:04:59.000Z")), false);
  assert.equal(isTimerDue(overnight, new Date("2026-08-10T07:05:00.000Z")), true);
});

test("dispatcher submits only due timers through the server-side close path", async () => {
  const calls = [];
  const rows = [
    { id: "due", system_type: "ac", start_at: "2026-08-09T18:00:00.000Z", timer_stop: "11:15:00" },
    { id: "future", system_type: "heat", start_at: "2026-08-09T18:00:00.000Z", timer_stop: "11:45:00" }
  ];
  const fetcher = async () => ({ ok: true, json: async () => rows });
  const executeOff = async (options) => {
    calls.push(options);
    return { success: true };
  };

  const result = await dispatchDueTimers({
    now: new Date("2026-08-09T18:20:00.000Z"),
    fetcher,
    executeOff
  });

  assert.equal(result.checkedCount, 2);
  assert.equal(result.dueCount, 1);
  assert.equal(result.completedCount, 1);
  assert.equal(result.failedCount, 0);
  assert.deepEqual(calls, [{
    requestedSystemType: "ac",
    heaterUseEntryId: "due",
    timerTriggered: true,
    timerMinutes: 15,
    closeEntry: true,
    endAt: "2026-08-09T18:20:00.000Z"
  }]);
});

test("timer shutdown closes the runtime after Ecobee accepts the off command", async () => {
  const priorServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const priorHeatId = process.env.ECOBEE_HEATER_THERMOSTAT_ID;
  const priorAcId = process.env.ECOBEE_AC_THERMOSTAT_ID;
  const priorFetch = global.fetch;
  const events = [];

  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  process.env.ECOBEE_HEATER_THERMOSTAT_ID = "heat-thermostat";
  process.env.ECOBEE_AC_THERMOSTAT_ID = "ac-thermostat";
  mockModule(ecobeeClientPath, {
    stopEcobeeHvac: async () => events.push("stop")
  });
  global.fetch = async (url, options = {}) => {
    const requestUrl = String(url);
    if (requestUrl.includes("heater_use_entries?select=")) {
      return {
        ok: true,
        json: async () => [{
          id: "timer-entry",
          system_type: "ac",
          responsible_member_id: "member-1",
          group_pay: false,
          set_a_timer: true,
          turn_heater_on: "On",
          start_at: "2026-08-09T18:00:00.000Z",
          end_at: null
        }]
      };
    }
    if (requestUrl.includes("heater_use_entries?") && options.method === "PATCH") {
      events.push("close-record");
      return { ok: true, json: async () => [{ id: "timer-entry" }] };
    }
    if (requestUrl.includes("automation_settings")) {
      return { ok: true, json: async () => [{ config: { enabled: false } }] };
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  };

  delete require.cache[heaterOffModulePath];
  try {
    const { executeHeaterOff } = require(heaterOffModulePath);
    const result = await executeHeaterOff({
      requestedSystemType: "ac",
      heaterUseEntryId: "timer-entry",
      timerTriggered: true,
      timerMinutes: 15,
      closeEntry: true,
      endAt: "2026-08-09T18:15:00.000Z"
    });

    assert.equal(result.success, true);
    assert.deepEqual(events, ["stop", "close-record"]);
  } finally {
    global.fetch = priorFetch;
    if (priorServiceKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = priorServiceKey;
    if (priorHeatId === undefined) delete process.env.ECOBEE_HEATER_THERMOSTAT_ID;
    else process.env.ECOBEE_HEATER_THERMOSTAT_ID = priorHeatId;
    if (priorAcId === undefined) delete process.env.ECOBEE_AC_THERMOSTAT_ID;
    else process.env.ECOBEE_AC_THERMOSTAT_ID = priorAcId;
    delete require.cache[heaterOffModulePath];
    delete require.cache[ecobeeClientPath];
  }
});

test("a failed Ecobee timer shutdown leaves the runtime open for retry", async () => {
  const priorServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const priorHeatId = process.env.ECOBEE_HEATER_THERMOSTAT_ID;
  const priorAcId = process.env.ECOBEE_AC_THERMOSTAT_ID;
  const priorFetch = global.fetch;
  let patchCount = 0;

  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  process.env.ECOBEE_HEATER_THERMOSTAT_ID = "heat-thermostat";
  process.env.ECOBEE_AC_THERMOSTAT_ID = "ac-thermostat";
  mockModule(ecobeeClientPath, {
    stopEcobeeHvac: async () => { throw new Error("Ecobee unavailable"); }
  });
  global.fetch = async (url, options = {}) => {
    if (options.method === "PATCH") patchCount += 1;
    if (String(url).includes("heater_use_entries?select=")) {
      return {
        ok: true,
        json: async () => [{
          id: "timer-entry",
          system_type: "ac",
          responsible_member_id: "member-1",
          group_pay: false,
          set_a_timer: true,
          turn_heater_on: "On",
          start_at: "2026-08-09T18:00:00.000Z",
          end_at: null
        }]
      };
    }
    throw new Error(`Unexpected request: ${String(url)}`);
  };

  delete require.cache[heaterOffModulePath];
  try {
    const { executeHeaterOff } = require(heaterOffModulePath);
    await assert.rejects(executeHeaterOff({
      requestedSystemType: "ac",
      heaterUseEntryId: "timer-entry",
      closeEntry: true
    }), /Ecobee unavailable/);
    assert.equal(patchCount, 0);
  } finally {
    global.fetch = priorFetch;
    if (priorServiceKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = priorServiceKey;
    if (priorHeatId === undefined) delete process.env.ECOBEE_HEATER_THERMOSTAT_ID;
    else process.env.ECOBEE_HEATER_THERMOSTAT_ID = priorHeatId;
    if (priorAcId === undefined) delete process.env.ECOBEE_AC_THERMOSTAT_ID;
    else process.env.ECOBEE_AC_THERMOSTAT_ID = priorAcId;
    delete require.cache[heaterOffModulePath];
    delete require.cache[ecobeeClientPath];
  }
});

test("Vercel invokes thermostat timer dispatch every minute", () => {
  const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "vercel.json"), "utf8"));
  assert.ok(config.crons.some((cron) => (
    cron.path === "/api/dispatch-thermostat-timers" && cron.schedule === "* * * * *"
  )));
});
