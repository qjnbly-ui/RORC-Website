const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const heaterOnModulePath = require.resolve("../api/heater-on-sequence.js");
const ecobeeClientPath = require.resolve("../api/_ecobee-client.js");

function mockModule(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports
  };
}

function loadHeaterOnWithEcobee(ecobee) {
  delete require.cache[heaterOnModulePath];
  mockModule(ecobeeClientPath, ecobee);
  return require(heaterOnModulePath);
}

function restoreEnvironment(prior) {
  global.fetch = prior.fetch;
  if (prior.serviceKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = prior.serviceKey;
  if (prior.heatId === undefined) delete process.env.ECOBEE_HEATER_THERMOSTAT_ID;
  else process.env.ECOBEE_HEATER_THERMOSTAT_ID = prior.heatId;
  if (prior.acId === undefined) delete process.env.ECOBEE_AC_THERMOSTAT_ID;
  else process.env.ECOBEE_AC_THERMOSTAT_ID = prior.acId;
  delete require.cache[heaterOnModulePath];
  delete require.cache[ecobeeClientPath];
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

test("a failed thermostat start confirms off before canceling the billable runtime", async () => {
  const prior = prepareEnvironment();
  const events = [];
  global.fetch = async (_url, options = {}) => {
    if (options.method === "PATCH") {
      events.push("close-record");
      return { ok: true, json: async () => [{ id: "runtime-1" }] };
    }
    throw new Error("Unexpected fetch");
  };

  const { startThermostatRuntime } = loadHeaterOnWithEcobee({
    setEcobeeTemperatureHold: async () => {
      events.push("start-failed");
      throw new Error("Ecobee unavailable");
    },
    resumeEcobeeProgram: async () => events.push("resume"),
    setEcobeeHvacMode: async () => events.push("mode-off")
  });

  try {
    await assert.rejects(startThermostatRuntime({
      entry: {
        id: "runtime-1",
        systemType: "ac",
        startAt: "2026-08-09T18:00:00.000Z"
      },
      targetTemperatureF: 68
    }), /Ecobee unavailable/);
    assert.deepEqual(events, ["start-failed", "resume", "mode-off", "close-record"]);
  } finally {
    restoreEnvironment(prior);
  }
});

test("an uncertain failed start remains open when shutdown cannot be confirmed", async () => {
  const prior = prepareEnvironment();
  let patchCount = 0;
  global.fetch = async (_url, options = {}) => {
    if (options.method === "PATCH") patchCount += 1;
    throw new Error("Unexpected fetch");
  };

  const { startThermostatRuntime } = loadHeaterOnWithEcobee({
    setEcobeeTemperatureHold: async () => { throw new Error("Start request failed"); },
    resumeEcobeeProgram: async () => { throw new Error("Shutdown request failed"); },
    setEcobeeHvacMode: async () => {}
  });

  try {
    await assert.rejects(startThermostatRuntime({
      entry: { id: "runtime-1", systemType: "heat", startAt: "2026-08-09T18:00:00.000Z" },
      targetTemperatureF: 70
    }), /Automatic shutdown could not be confirmed/);
    assert.equal(patchCount, 0);
  } finally {
    restoreEnvironment(prior);
  }
});

test("temperature changes reach Ecobee before the runtime record and restore the prior hold on a database failure", async () => {
  const prior = prepareEnvironment();
  const targets = [];
  global.fetch = async (_url, options = {}) => {
    if (options.method === "PATCH") {
      return { ok: false, status: 500, text: async () => "database unavailable" };
    }
    throw new Error("Unexpected fetch");
  };

  const { changeThermostatTemperature } = loadHeaterOnWithEcobee({
    setEcobeeTemperatureHold: async (options) => targets.push(options.targetTemperatureF),
    resumeEcobeeProgram: async () => {},
    setEcobeeHvacMode: async () => {}
  });

  try {
    await assert.rejects(changeThermostatTemperature({
      entry: {
        id: "runtime-1",
        systemType: "ac",
        targetTemperatureF: 72
      },
      targetTemperatureF: 68
    }), /Could not save thermostat temperature/);
    assert.deepEqual(targets, [68, 72]);
  } finally {
    restoreEnvironment(prior);
  }
});

test("browser stop flow delegates both Ecobee shutdown and runtime closure to the server", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "..", "RORC App", "app.js"), "utf8");
  const start = source.indexOf("async function turnHeaterOffActiveEntry");
  const end = source.indexOf("async function turnHeaterOffEntry", start);
  const functionSource = source.slice(start, end);

  assert.match(functionSource, /await triggerHeaterOffSequence/);
  assert.doesNotMatch(functionSource, /\.from\("heater_use_entries"\)/);
  assert.doesNotMatch(functionSource, /Heater off sequence failed/);
});
