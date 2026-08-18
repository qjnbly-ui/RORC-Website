const assert = require("node:assert/strict");
const test = require("node:test");

const { runAutomationStep } = require("../api/_automation-step");
const { isCronAuthorized, resolveVoiceMonkeyUrl } = require("../api/_automation-security");

test("automation steps checkpoint before and after an external action", async () => {
  const events = [];
  const completedSteps = new Set();
  await runAutomationStep({
    req: { automationHooks: {
      beforeStep: async (step) => events.push(`before:${step}`),
      afterStep: async (step) => events.push(`after:${step}`)
    }},
    completedSteps,
    step: "announcement",
    action: async () => events.push("action")
  });
  assert.deepEqual(events, ["before:announcement", "action", "after:announcement"]);
  assert.deepEqual([...completedSteps], ["announcement"]);
});

test("a failed external step is marked in-flight for no-repeat handling", async () => {
  const error = await runAutomationStep({
    req: {},
    completedSteps: new Set(["lights"]),
    step: "sms:0",
    action: async () => { throw new Error("unknown provider outcome"); }
  }).catch((caught) => caught);
  assert.equal(error.inFlightStep, "sms:0");
  assert.deepEqual(error.completedSteps, ["lights"]);
});

test("cron authorization fails closed and webhook URLs are allowlisted", () => {
  const prior = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  assert.equal(isCronAuthorized({ headers: {} }), false);
  process.env.CRON_SECRET = "secret";
  assert.equal(isCronAuthorized({ headers: { authorization: "Bearer secret" } }), true);
  assert.throws(() => resolveVoiceMonkeyUrl({
    settingValue: "https://example.com/hook",
    environmentName: "MISSING_AUTOMATION_TEST_URL",
    label: "Test URL"
  }), /approved VoiceMonkey/);
  if (prior === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = prior;
});
