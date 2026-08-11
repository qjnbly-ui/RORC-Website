const assert = require("node:assert/strict");
const test = require("node:test");

const clientPath = require.resolve("../api/_ecobee-client.js");

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  };
}

async function withEcobeeClient(fetcher, callback) {
  const prior = {
    fetch: global.fetch,
    clientId: process.env.ECOBEE_CLIENT_ID,
    accessToken: process.env.ECOBEE_ACCESS_TOKEN,
    refreshToken: process.env.ECOBEE_REFRESH_TOKEN
  };

  process.env.ECOBEE_CLIENT_ID = "test-client";
  process.env.ECOBEE_ACCESS_TOKEN = "initial-token";
  process.env.ECOBEE_REFRESH_TOKEN = "refresh-token";
  global.fetch = fetcher;
  delete require.cache[clientPath];

  try {
    await callback(require(clientPath));
  } finally {
    global.fetch = prior.fetch;
    restoreEnvironmentValue("ECOBEE_CLIENT_ID", prior.clientId);
    restoreEnvironmentValue("ECOBEE_ACCESS_TOKEN", prior.accessToken);
    restoreEnvironmentValue("ECOBEE_REFRESH_TOKEN", prior.refreshToken);
    delete require.cache[clientPath];
  }
}

function restoreEnvironmentValue(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("fan holds include Ecobee's required current heat and cool setpoints", async () => {
  const requests = [];

  await withEcobeeClient(async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (options.method === "GET") {
      return jsonResponse({
        status: { code: 0 },
        thermostatList: [{
          runtime: {
            desiredHeat: 620,
            desiredCool: 760,
            desiredHeatRange: [450, 790],
            desiredCoolRange: [650, 920]
          }
        }]
      });
    }
    return jsonResponse({ status: { code: 0 } });
  }, async ({ setEcobeeFanHold }) => {
    await setEcobeeFanHold({
      thermostatId: "ac-thermostat",
      fan: "on",
      holdType: "indefinite"
    });
  });

  assert.equal(requests.length, 2);
  const readRequest = requests[0];
  const readUrl = new URL(readRequest.url);
  const readBody = JSON.parse(readUrl.searchParams.get("json"));
  assert.deepEqual(readBody.selection, {
    selectionType: "thermostats",
    selectionMatch: "ac-thermostat",
    includeSettings: false,
    includeRuntime: true,
    includeSensors: false,
    includeWeather: false,
    includeEvents: false,
    includeEquipmentStatus: false
  });

  const command = JSON.parse(requests[1].options.body);
  assert.deepEqual(command, {
    selection: {
      selectionType: "thermostats",
      selectionMatch: "ac-thermostat"
    },
    functions: [{
      type: "setHold",
      params: {
        holdType: "indefinite",
        heatHoldTemp: 620,
        coolHoldTemp: 760,
        fan: "on"
      }
    }]
  });
});

test("sign-out resume removes only the top Ecobee hold", async () => {
  let command = null;

  await withEcobeeClient(async (_url, options = {}) => {
    command = JSON.parse(options.body);
    return jsonResponse({ status: { code: 0 } });
  }, async ({ resumeEcobeeProgram }) => {
    await resumeEcobeeProgram({ thermostatId: "ac-thermostat" });
  });

  assert.deepEqual(command.functions, [{
    type: "resumeProgram",
    params: { resumeAll: false }
  }]);
});

test("AC shutdown sends mode off and hold removal in one Ecobee update", async () => {
  const requests = [];

  await withEcobeeClient(async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return jsonResponse({ status: { code: 0 } });
  }, async ({ stopEcobeeHvac }) => {
    await stopEcobeeHvac({ thermostatId: "ac-thermostat" });
  });

  assert.equal(requests.length, 1);
  const command = JSON.parse(requests[0].options.body);
  assert.deepEqual(command.thermostat, { settings: { hvacMode: "off" } });
  assert.deepEqual(command.functions, [{
    type: "resumeProgram",
    params: { resumeAll: false }
  }]);
});

test("runtime reports use Ecobee's documented body query parameter once", async () => {
  const requests = [];

  await withEcobeeClient(async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return jsonResponse({ status: { code: 0 }, reportList: [] });
  }, async ({ getEcobeeRuntimeReport }) => {
    await getEcobeeRuntimeReport({
      thermostatId: "ac-thermostat",
      startDate: "2026-08-01",
      endDate: "2026-08-02",
      columns: "auxHeat1,compCool1"
    });
  });

  assert.equal(requests.length, 1);
  const requestUrl = new URL(requests[0].url);
  assert.ok(requestUrl.searchParams.has("body"));
  assert.equal(requestUrl.searchParams.has("json"), false);
  const body = JSON.parse(requestUrl.searchParams.get("body"));
  assert.equal(body.selection.selectionMatch, "ac-thermostat");
  assert.equal(body.columns, "auxHeat1,compCool1");
});

test("a refreshed Ecobee token is reused instead of invalidating it on each command", async () => {
  const authorizationHeaders = [];
  let refreshCount = 0;

  await withEcobeeClient(async (url, options = {}) => {
    if (String(url).endsWith("/token")) {
      refreshCount += 1;
      return jsonResponse({ access_token: "fresh-token" });
    }

    authorizationHeaders.push(options.headers.Authorization);
    if (options.headers.Authorization === "Bearer initial-token") {
      return jsonResponse({ status: { code: 14, message: "Authentication token has expired" } }, { status: 500 });
    }
    return jsonResponse({ status: { code: 0 } });
  }, async ({ setEcobeeHvacMode }) => {
    await setEcobeeHvacMode({ thermostatId: "ac-thermostat", mode: "cool" });
    await setEcobeeHvacMode({ thermostatId: "ac-thermostat", mode: "off" });
  });

  assert.equal(refreshCount, 1);
  assert.deepEqual(authorizationHeaders, [
    "Bearer initial-token",
    "Bearer fresh-token",
    "Bearer fresh-token"
  ]);
});
