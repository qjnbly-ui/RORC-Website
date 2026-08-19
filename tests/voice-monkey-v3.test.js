const assert = require("node:assert/strict");
const test = require("node:test");

const {
  VOICE_MONKEY_V3_ORIGIN,
  announceVoiceMonkey,
  callVoiceMonkeyV3,
  triggerVoiceMonkey,
  voiceMonkeyApiVersion
} = require("../api/_voice-monkey");
const { flushFacilityAutomation } = require("../api/timesheet-entries");

function preserveEnvironment(names) {
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  return () => names.forEach((name) => {
    if (prior[name] === undefined) delete process.env[name];
    else process.env[name] = prior[name];
  });
}

test("v3 routine triggers keep the API token out of the URL and request body", async () => {
  const restore = preserveEnvironment(["VOICEMONKEY_API_VERSION", "VOICEMONKEY_API_TOKEN"]);
  process.env.VOICEMONKEY_API_VERSION = "v3";
  process.env.VOICEMONKEY_API_TOKEN = "secret-production-token";
  const calls = [];
  try {
    await triggerVoiceMonkey({
      v3Device: "all-lights-on-bskri",
      v3EnvironmentName: "MISSING_V3_TRIGGER_DEVICE",
      label: "All lights",
      fetcher: async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => ({ success: true }) };
      }
    });
  } finally {
    restore();
  }

  assert.equal(calls[0].url, `${VOICE_MONKEY_V3_ORIGIN}/trigger`);
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret-production-token");
  assert.deepEqual(JSON.parse(calls[0].options.body), { device: "all-lights-on-bskri" });
  assert.doesNotMatch(calls[0].url, /secret-production-token/);
  assert.doesNotMatch(calls[0].options.body, /secret-production-token/);
});

test("v3 announcements use the new announce endpoint and speech field", async () => {
  const restore = preserveEnvironment(["VOICEMONKEY_API_VERSION", "VOICEMONKEY_API_TOKEN"]);
  process.env.VOICEMONKEY_API_VERSION = "v3";
  process.env.VOICEMONKEY_API_TOKEN = "secret-production-token";
  let request;
  try {
    await announceVoiceMonkey({
      v3Device: "stage-only-announcement-5aylv",
      v3EnvironmentName: "MISSING_V3_SPEAKER_DEVICE",
      speech: "Welcome to RORC.",
      voice: "Joanna",
      chime: "soundbank://soundlibrary/alarms/beeps_and_bloops/intro_02",
      characterDisplay: "Welcome",
      label: "Opening announcement",
      fetcher: async (url, options) => {
        request = { url, options };
        return { ok: true, json: async () => ({ success: true }) };
      }
    });
  } finally {
    restore();
  }

  assert.equal(request.url, `${VOICE_MONKEY_V3_ORIGIN}/announce`);
  assert.deepEqual(JSON.parse(request.options.body), {
    device: "stage-only-announcement-5aylv",
    speech: "Welcome to RORC.",
    voice: "Joanna",
    chime: "soundbank://soundlibrary/alarms/beeps_and_bloops/intro_02",
    character_display: "Welcome"
  });
});

test("v3 retries only an explicit throttle response after its lockout", async () => {
  const restore = preserveEnvironment(["VOICEMONKEY_API_TOKEN"]);
  process.env.VOICEMONKEY_API_TOKEN = "secret-production-token";
  const waits = [];
  let attempt = 0;
  try {
    const result = await callVoiceMonkeyV3("/trigger", { device: "all-lights-on-bskri" }, async () => {
      attempt += 1;
      if (attempt === 1) {
        return {
          ok: false,
          status: 429,
          json: async () => ({ error: "THROTTLED", lockoutUntil: "1970-01-01T00:00:01.000Z" })
        };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    }, {
      now: () => 0,
      sleep: async (milliseconds) => waits.push(milliseconds)
    });
    assert.equal(result.success, true);
  } finally {
    restore();
  }
  assert.equal(attempt, 2);
  assert.deepEqual(waits, [1100]);
});

test("v3 does not retry an ambiguous Alexa failure", async () => {
  const restore = preserveEnvironment(["VOICEMONKEY_API_TOKEN"]);
  process.env.VOICEMONKEY_API_TOKEN = "secret-production-token";
  let attempt = 0;
  try {
    await assert.rejects(() => callVoiceMonkeyV3("/announce", {
      device: "stage-only-announcement-5aylv",
      speech: "Welcome"
    }, async () => {
      attempt += 1;
      return { ok: false, status: 500, json: async () => ({ error: "ALEXA_TRIGGER_FAILED" }) };
    }), /ALEXA_TRIGGER_FAILED/);
  } finally {
    restore();
  }
  assert.equal(attempt, 1);
});

test("v2 remains the default during the staged cutover", async () => {
  const restore = preserveEnvironment(["VOICEMONKEY_API_VERSION", "VOICEMONKEY_API_TOKEN"]);
  delete process.env.VOICEMONKEY_API_VERSION;
  delete process.env.VOICEMONKEY_API_TOKEN;
  const calls = [];
  try {
    assert.equal(voiceMonkeyApiVersion(), "v2");
    await triggerVoiceMonkey({
      legacySettingValue: "https://api-v2.voicemonkey.io/trigger?token=redacted&device=legacy",
      legacyEnvironmentName: "MISSING_V2_TRIGGER_URL",
      label: "Legacy lights",
      fetcher: async (url, options) => {
        calls.push({ url, options });
        return { ok: true };
      }
    });
  } finally {
    restore();
  }
  assert.equal(calls[0].options.method, "GET");
  assert.match(calls[0].url, /^https:\/\/api-v2\.voicemonkey\.io\/trigger/);
});

test("the kiosk immediately drains the durable automation queue", async () => {
  const calls = [];
  const result = await flushFacilityAutomation({
    headers: { host: "www.ruthobenchainrc.com", "x-forwarded-proto": "https" }
  }, async (options) => {
    calls.push(options);
    return { claimedCount: 1, completedCount: 1 };
  });
  assert.deepEqual(calls, [{ origin: "https://www.ruthobenchainrc.com" }]);
  assert.equal(result.completedCount, 1);
});

test("a failed immediate drain leaves the cron fallback available", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await flushFacilityAutomation({ headers: { host: "example.test" } }, async () => {
      throw new Error("temporary failure");
    });
    assert.equal(result.deferredToCron, true);
    assert.equal(result.failedCount, 1);
  } finally {
    console.error = originalError;
  }
});
