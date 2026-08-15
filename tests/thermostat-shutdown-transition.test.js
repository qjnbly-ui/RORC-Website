const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appSource = fs.readFileSync(path.join(__dirname, "../RORC App/app.js"), "utf8");

test("forced thermostat status reads bypass the assembled server cache", () => {
  assert.match(
    appSource,
    /const statusUrl = force \? "\/api\/thermostat-status\?refresh=1" : "\/api\/thermostat-status"/
  );
});

test("shutdown remains locked while Ecobee reports HVAC or automatic fan equipment", () => {
  const start = appSource.indexOf("function isThermostatShutdownComplete");
  const end = appSource.indexOf("function latestCompletedThermostatEntry", start);
  const helperSource = appSource.slice(start, end);

  assert.match(helperSource, /hvacMode[\s\S]*!== "off"/);
  assert.match(helperSource, /systemType === "ac" && item\?\.isCooling/);
  assert.match(helperSource, /systemType === "heat" && item\?\.isHeating/);
  assert.match(helperSource, /equipmentFanRunning/);
  assert.match(helperSource, /circulationFanRequested/);
  assert.match(helperSource, /return !equipmentFanRunning \|\| circulationFanRequested/);

  const pendingStart = appSource.indexOf("function isThermostatShutdownPending");
  const pendingEnd = appSource.indexOf("function stopThermostatShutdownMonitor", pendingStart);
  const pendingSource = appSource.slice(pendingStart, pendingEnd);
  assert.match(pendingSource, /automaticFanRunning/);
  assert.match(pendingSource, /shutdownEquipmentRunning/);
  assert.match(pendingSource, /if \(shutdownEquipmentRunning\) return true/);
});

test("thermostat card disables repeat commands during shutdown", () => {
  const start = appSource.indexOf("function renderThermostatSystemStatus");
  const end = appSource.indexOf("function renderThermostatStatusPanel", start);
  const renderSource = appSource.slice(start, end);

  assert.match(renderSource, /if \(shutdownPending\)/);
  assert.match(renderSource, /aria-busy="true"/);
  assert.match(renderSource, /<button class="thermostat-card-off-button" type="button" disabled>Turning Off\.\.\.<\/button>/);
  assert.ok(
    renderSource.indexOf("if (shutdownPending)") < renderSource.indexOf("if (isRecordActive || isLiveActive)"),
    "shutdown state must render before active controls"
  );
});

test("turn-on validation rejects a system still finishing shutdown", () => {
  const start = appSource.indexOf("async function saveHeaterUse");
  const end = appSource.indexOf("function bindFormActions", start);
  const saveSource = appSource.slice(start, end);

  assert.match(saveSource, /isThermostatShutdownPending\(systemType, statusItem\)/);
  assert.match(saveSource, /still finishing shutdown/);
});
