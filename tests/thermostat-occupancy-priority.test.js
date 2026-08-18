const assert = require("node:assert/strict");
const test = require("node:test");

const ecobeeClientPath = require.resolve("../api/_ecobee-client.js");
const runtimeStatePath = require.resolve("../api/_thermostat-runtime-state.js");
const lightsOnPath = require.resolve("../api/gym-lights-on-sequence.js");
const lightsOffPath = require.resolve("../api/gym-lights-off-sequence.js");

function mockModule(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports
  };
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

async function runSequence({ sequence, acRuntimeActive, runtimeError = null }) {
  const ecobeeCalls = [];
  const oldFetch = global.fetch;
  const oldServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const oldThermostatId = process.env.ECOBEE_AC_THERMOSTAT_ID;
  const oldCronSecret = process.env.CRON_SECRET;

  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  process.env.ECOBEE_AC_THERMOSTAT_ID = "ac-thermostat";
  process.env.CRON_SECRET = "test-cron-secret";
  global.fetch = async (url) => {
    assert.match(String(url), /automation_settings/);
    return {
      ok: true,
      json: async () => [{
        config: {
          enabled: true,
          step1_enabled: false,
          step2_enabled: false,
          sms_enabled: false,
          ac_fan_enabled: true
        }
      }]
    };
  };

  mockModule(ecobeeClientPath, {
    setEcobeeFanHold: async (options) => ecobeeCalls.push({ action: "fan_on", options }),
    resumeEcobeeProgram: async (options) => ecobeeCalls.push({ action: "resume", options })
  });
  mockModule(runtimeStatePath, {
    hasActiveThermostatRuntime: async () => {
      if (runtimeError) throw runtimeError;
      return acRuntimeActive;
    }
  });

  const sequencePath = sequence === "on" ? lightsOnPath : lightsOffPath;
  delete require.cache[sequencePath];

  try {
    const handler = require(sequencePath);
    const req = {
      method: "POST",
      headers: { host: "example.test", authorization: "Bearer test-cron-secret" },
      body: { memberName: "Test Member", visitDurationMinutes: 30 }
    };
    const res = responseRecorder();
    await handler(req, res);
    return { ecobeeCalls, response: res };
  } finally {
    global.fetch = oldFetch;
    if (oldServiceKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = oldServiceKey;
    if (oldThermostatId === undefined) delete process.env.ECOBEE_AC_THERMOSTAT_ID;
    else process.env.ECOBEE_AC_THERMOSTAT_ID = oldThermostatId;
    if (oldCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = oldCronSecret;
    delete require.cache[sequencePath];
    delete require.cache[ecobeeClientPath];
    delete require.cache[runtimeStatePath];
  }
}

test("sign-in fan automation does not replace an active AC runtime", async () => {
  const result = await runSequence({ sequence: "on", acRuntimeActive: true });

  assert.equal(result.response.statusCode, 200);
  assert.equal(result.response.body.fanAutomationSkipped, "active_ac");
  assert.deepEqual(result.ecobeeCalls, []);
});

test("sign-out fan automation does not resume the program during an active AC runtime", async () => {
  const result = await runSequence({ sequence: "off", acRuntimeActive: true });

  assert.equal(result.response.statusCode, 200);
  assert.equal(result.response.body.fanAutomationSkipped, "active_ac");
  assert.deepEqual(result.ecobeeCalls, []);
});

test("occupancy fan automation still runs when AC has no active runtime", async () => {
  const signIn = await runSequence({ sequence: "on", acRuntimeActive: false });
  const signOut = await runSequence({ sequence: "off", acRuntimeActive: false });

  assert.deepEqual(signIn.ecobeeCalls, [{
    action: "fan_on",
    options: { thermostatId: "ac-thermostat", fan: "on", holdType: "indefinite" }
  }]);
  assert.deepEqual(signOut.ecobeeCalls, [{
    action: "resume",
    options: { thermostatId: "ac-thermostat" }
  }]);
});

test("a failed AC priority check leaves the thermostat untouched", async () => {
  const result = await runSequence({
    sequence: "off",
    acRuntimeActive: false,
    runtimeError: new Error("database unavailable")
  });

  assert.equal(result.response.statusCode, 200);
  assert.equal(result.response.body.fanAutomationSkipped, "priority_check_failed");
  assert.match(result.response.body.warnings[0], /database unavailable/);
  assert.deepEqual(result.ecobeeCalls, []);
});

test("active runtime lookup targets only open, started AC-on records", async () => {
  const oldFetch = global.fetch;
  let requestedUrl = "";
  global.fetch = async (url) => {
    requestedUrl = String(url);
    return {
      ok: true,
      json: async () => [{ id: "active-ac-entry" }]
    };
  };

  delete require.cache[runtimeStatePath];
  try {
    const { hasActiveThermostatRuntime } = require(runtimeStatePath);
    const active = await hasActiveThermostatRuntime({
      supabaseUrl: "https://example.supabase.co/",
      serviceRoleKey: "service-key",
      systemType: "ac"
    });

    assert.equal(active, true);
    const query = new URL(requestedUrl).searchParams;
    assert.equal(query.get("system_type"), "eq.ac");
    assert.equal(query.get("turn_heater_on"), "eq.On");
    assert.equal(query.get("start_at"), "not.is.null");
    assert.equal(query.get("end_at"), "is.null");
    assert.equal(query.get("limit"), "1");
  } finally {
    global.fetch = oldFetch;
    delete require.cache[runtimeStatePath];
  }
});
