const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appSource = fs.readFileSync(path.resolve(__dirname, "..", "RORC App", "app.js"), "utf8");

test("bot settings uses admin-only contact menus for automation SMS recipients", () => {
  assert.equal((appSource.match(/data-member-picker-source="adminSmsRecipients"/g) || []).length, 2);
  assert.match(appSource, /canonicalAccountType\(member\.accountType\) === "Account Manager"/);
  assert.match(appSource, /normalizeCommunicationsPhone\(member\.phoneNumber \|\| member\.phone_number\)/);
  assert.doesNotMatch(appSource, /id="gymLights(?:On|Off)SmsTo"/);
});

test("automation SMS menus preserve the existing backend phone-number contract", () => {
  assert.match(appSource, /automationSmsRecipientMemberIds\(settings\.gym_lights_on\?\.sms_to\)/);
  assert.match(appSource, /automationSmsRecipientMemberIds\(settings\.gym_lights_off\?\.sms_to\)/);
  assert.match(appSource, /sms_to: automationSmsDestinations\("gymLightsOnSmsRecipients"\)/);
  assert.match(appSource, /sms_to: automationSmsDestinations\("gymLightsOffSmsRecipients"\)/);
  assert.match(appSource, /return \[\.\.\.new Set\(destinations\)\]\.join\(", "\);/);
});

test("bot settings loads the full member directory before rendering admin recipients", () => {
  assert.match(appSource, /if \(routeName === "message"\) return \["directory"\];/);
  assert.match(appSource, /await ensureResource\("directory"\);\s+if \(appState\.currentRoute !== "message"\) return;\s+await bindAutomationSettingsActions/);
  assert.match(appSource, /source === "adminSmsRecipients"/);
  assert.match(appSource, /Choose one or more Account Manager contacts with a saved phone number\./);
});
