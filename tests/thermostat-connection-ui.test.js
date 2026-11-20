const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../RORC App/app.js"), "utf8");
function appFunctions(first, after) {
  const start = source.indexOf(first);
  const end = source.indexOf(after, start + first.length);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

function page() {
  const context = vm.createContext({
    thermostatStatus: { thermostats: {} },
    thermostatStatusFetchedAt: 0,
    THERMOSTAT_STATUS_CACHE_MS: 60000,
    THERMOSTAT_SHUTDOWN_LOCK_MAX_MS: 300000,
    heaterUseEntries: [],
    thermostatActionFeedback: null,
    currentAuthSession: { access_token: "test" },
    unconfirmedThermostatShutdowns: new Map(),
    normalizeThermostatSystemType: (system) => system,
    isThermostatSystemEnabled: () => true,
    activeHeaterEntry: () => null,
    heaterAutoShutoffText: (entry) => entry?.timerStop || "",
    escapeHtml: String,
    escapeAttribute: String
  });
  vm.runInContext([
    appFunctions("async function fetchThermostatStatus(", "async function triggerHeaterOffSequence("),
    appFunctions("function thermostatSetPointForSystem(", "function stopThermostatShutdownMonitor("),
    appFunctions("function markThermostatSystemOff(", "function markThermostatSystemOn("),
    appFunctions("function firstConfiguredThermostat(", "function renderThermostatStatusPanel("),
    appFunctions("async function turnHeaterOffActiveEntry(", "async function turnHeaterOffEntry(")
  ].join("\n"), context);
  return context;
}

test("offline active timers retain the early-stop control bound to the selected run", () => {
  const app = page();
  const offline = { configured: true, connected: false, stale: true, isHeating: true };
  const html = app.renderThermostatSystemStatus("Heat", offline, { id: "my-run", systemType: "heat", timerStop: "4:42 PM" });
  assert.match(html, /Ecobee offline/);
  assert.match(html, /4:42 PM/);
  assert.match(html, /data-turn-thermostat-entry-id="my-run" type="button">Turn Off/);
  assert.doesNotMatch(html, /data-change-thermostat-temp|Currently On|<strong>Heating/);
  assert.doesNotMatch(app.renderThermostatSystemStatus("Heat", offline), /data-open-thermostat-system|data-turn-thermostat-off/);
});

test("repeated offline and pre-command readings cannot clear an accepted shutdown", async () => {
  const app = page();
  const requestedAt = Date.now() - 10 * 60000;
  const disconnected = { configured: true, connected: false, stale: true };
  const off = { configured: true, connected: true, hvacMode: "off", equipmentStatus: "", currentActivity: "Off" };
  app.markThermostatSystemOff("heat", new Date(requestedAt).toISOString());
  const show = async (item) => {
    app.appApiFetch = async () => ({ ok: true, json: async () => ({ thermostats: { heat: item } }) });
    await app.fetchThermostatStatus({ force: true });
    return app.renderThermostatSystemStatus("Heat", item);
  };
  assert.match(await show(disconnected), /Shutdown unconfirmed/);
  assert.match(await show({ ...off, connectionCheckedAt: new Date(requestedAt - 1).toISOString() }), /Waiting for Ecobee confirmation/);
  const fresh = { ...off, connectionCheckedAt: new Date().toISOString() };
  assert.match(await show({ ...fresh, equipmentStatus: "fan", isFanRunning: true }), /Finishing the shutdown fan cycle/);
  assert.ok(app.unconfirmedThermostatShutdowns.has("heat"));
  assert.match(await show(fresh), /<strong>Off<\/strong>/);
  assert.equal(app.unconfirmedThermostatShutdowns.size, 0);
});

test("an unknown connection or a stale reading cannot confirm Off or supply live room data", () => {
  const app = page();
  const live = { configured: true, connected: true };
  const unknown = { ...live, connected: null, hvacMode: "off", connectionCheckedAt: new Date().toISOString() };
  const stale = { ...unknown, connected: true, stale: true };
  assert.match(app.renderThermostatSystemStatus("Heat", unknown), /Connection unknown/);
  assert.match(app.renderThermostatSystemStatus("Heat", stale), /Status stale/);
  assert.equal(app.isThermostatShutdownComplete("heat", unknown), false);
  assert.equal(app.isThermostatShutdownComplete("heat", stale), false);
  assert.equal(app.firstConfiguredThermostat(unknown, stale, live), live);
});

test("stopping an expired timer never sends a command for a newer run", async () => {
  const app = page();
  app.findActiveEntryByIdAndSystem = () => null;
  app.activeHeaterEntry = () => ({ id: "new-run" });
  app.appState = { currentRoute: "heaterRecords" };
  app.refreshHeaterResources = async () => {};
  app.render = () => {};
  app.triggerHeaterOffSequence = () => assert.fail("wrong run");
  await app.turnHeaterOffActiveEntry("heat", "old-run");
});
