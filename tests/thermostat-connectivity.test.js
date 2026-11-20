const assert = require("node:assert/strict");
const test = require("node:test");

function thermostatFixture(t) {
  const config = {
    SUPABASE_SERVICE_ROLE_KEY: "test-service",
    SUPABASE_URL: "https://supabase.test",
    ECOBEE_CLIENT_ID: "test-client",
    ECOBEE_ACCESS_TOKEN: "test-access",
    ECOBEE_REFRESH_TOKEN: "test-refresh",
    ECOBEE_HEATER_THERMOSTAT_ID: "gym",
    ECOBEE_AC_THERMOSTAT_ID: ""
  };
  const paths = ["../api/thermostat-status", "../api/_ecobee-client"].map((path) => require.resolve(path));
  for (const [key, value] of Object.entries(config)) {
    const original = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (original == null) delete process.env[key];
      else process.env[key] = original;
    });
  }
  for (const path of paths) delete require.cache[path];
  t.after(() => paths.forEach((path) => delete require.cache[path]));
  const handler = require(paths[0]);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const state = {
    revisions: ["gym:Gym:false:1:1:1:1"],
    equipment: ["gym:"],
    details: { identifier: "gym", isRegistered: true, settings: { hvacMode: "off" }, equipmentStatus: "" },
    detailReads: 0,
    summaryReads: 0
  };
  t.mock.method(global, "fetch", async (url) => {
    switch (new URL(url).pathname) {
      case "/auth/v1/user": return Response.json({ id: "user" });
      case "/rest/v1/account_members": return Response.json([{ id: "member" }]);
      case "/1/thermostatSummary":
        state.summaryReads++;
        return Response.json({ status: { code: 0 }, revisionList: state.revisions, statusList: state.equipment });
      case "/1/thermostat":
        state.detailReads++;
        return Response.json({ status: { code: 0 }, thermostatList: state.details ? [state.details] : [] });
      default: throw new Error("Unexpected request to " + url);
    }
  });

  return {
    state,
    advance() { now += 181000; },
    async read() {
      const req = { method: "GET", headers: { authorization: "Bearer session" }, query: { refresh: "1" } };
      const res = { status(code) { assert.equal(code, 200); return this; }, json: (data) => data };
      return (await handler(req, res)).thermostats.heat;
    }
  };
}

test("offline summary survives unavailable details and reconnect loads fresh equipment", async (t) => {
  const { state, read, advance } = thermostatFixture(t);
  const offline = await read();
  assert.equal(offline.connected, false);
  assert.equal(offline.stale, true);
  assert.equal(state.detailReads, 0);
  advance();
  state.revisions = ["gym:Gym:true:1:1:1:1"];
  const online = await read();
  assert.equal(online.connected, true);
  assert.equal(online.stale, false);
  assert.equal(online.hvacMode, "off");
  assert.equal(state.detailReads, 1);
  assert.ok(Date.parse(online.connectionCheckedAt) > Date.parse(offline.connectionCheckedAt));
  assert.equal((await read()).connectionCheckedAt, online.connectionCheckedAt);
  assert.equal(state.summaryReads, 2);
  advance();
  state.revisions = ["gym:Gym:false:1:1:1:1"];
  state.details = null;
  const disconnected = await read();
  assert.equal(disconnected.connected, false);
  assert.equal(disconnected.hvacMode, undefined);
  assert.equal(state.detailReads, 1);
});

test("missing or malformed connection rows stay unknown and device runtime is a fallback", async (t) => {
  const { state, read, advance } = thermostatFixture(t);
  state.revisions = ["other:Other:false:1:1:1:1"];
  state.equipment = ["other:auxHeat1"];
  delete state.details.equipmentStatus;
  const unknown = await read();
  assert.equal(unknown.connected, null);
  assert.equal(unknown.stale, true);
  assert.equal(unknown.isHeating, false);

  advance();
  state.revisions = ["gym:Gym:invalid:1:1:1:1"];
  state.details.runtime = { connected: false };
  assert.equal((await read()).connected, false);

  advance();
  state.details.runtime.connected = true;
  assert.equal((await read()).stale, true);
  state.details.equipmentStatus = "fan";
  const online = await read();
  assert.equal(online.connected, true);
  assert.equal(online.stale, false);
  assert.equal(online.isFanRunning, true);
});
