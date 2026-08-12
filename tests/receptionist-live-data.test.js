const test = require("node:test");
const assert = require("node:assert/strict");
const live = require("../api/_receptionist-live-data");
const receptionist = require("../api/receptionist/conversation");

function response(body, ok = true) {
  return { ok, status: ok ? 200 : 503, json: async () => body };
}

function snapshot(freshness = "fresh") {
  return {
    facility: {
      freshness,
      data: {
        success: true,
        activity: {
          occupancyCount: 2,
          roomTemperatureF: 68,
          roomHumidity: 37,
          checkinsToday: 3,
          checkinsThisWeek: 12,
          checkinsThisMonth: 28,
          activeMembers: 19,
          activeMemberAccounts: 11,
          weeklyTrends: {
            weeksAnalyzed: 8,
            busiest: { day: "Sun", hour: "6:00 PM", count: 9 },
            quietest: { day: "Mon", hour: "7:00 AM", count: 0 },
          },
        },
      },
    },
    events: { freshness: "fresh", data: { success: true, events: [] } },
  };
}

test("live context loads facility and event capabilities without phrase gates", async () => {
  live.resetLiveDataCache();
  const requested = [];
  const data = await live.loadReceptionistLiveData({
    baseUrl: "https://example.test",
    now: 1000,
    attempts: 1,
    fetch: async (url) => {
      requested.push(url);
      if (url.endsWith("/api/facility-activity")) return response({ success: true, activity: { roomTemperatureF: 68 } });
      return response({ success: true, events: [], facilityHours: {} });
    },
  });
  assert.deepEqual(requested.sort(), [
    "https://example.test/api/events",
    "https://example.test/api/facility-activity",
  ]);
  assert.equal(data.facility.data.activity.roomTemperatureF, 68);
  assert.equal(data.events.freshness, "fresh");
});

test("a routed live capability does not wait on an unrelated source", async () => {
  live.resetLiveDataCache();
  const requested = [];
  const data = await live.loadReceptionistLiveData({
    baseUrl: "https://example.test",
    now: 1000,
    sources: ["facility"],
    attempts: 1,
    fetch: async (url) => {
      requested.push(url);
      return response({ success: true, activity: { roomTemperatureF: 68 } });
    },
  });
  assert.deepEqual(requested, ["https://example.test/api/facility-activity"]);
  assert.equal(data.facility.freshness, "fresh");
  assert.equal(data.events.freshness, "skipped");
});

test("live context retries and serves a recent snapshot during a transient outage", async () => {
  live.resetLiveDataCache();
  const successful = async (url) => url.endsWith("/api/facility-activity")
    ? response({ success: true, activity: { roomTemperatureF: 68 } })
    : response({ success: true, events: [] });
  await live.loadReceptionistLiveData({ baseUrl: "https://example.test", now: 1000, attempts: 1, fetch: successful });

  let attempts = 0;
  const stale = await live.loadReceptionistLiveData({
    baseUrl: "https://example.test",
    now: 62000,
    attempts: 2,
    fetch: async () => { attempts += 1; throw new Error("temporary outage"); },
  });
  assert.equal(attempts, 4);
  assert.equal(stale.facility.freshness, "stale");
  assert.equal(stale.facility.data.activity.roomTemperatureF, 68);
  assert.equal(stale.events.freshness, "stale");
});

test("a partial facility response preserves the last valid value without calling it current", async () => {
  live.resetLiveDataCache();
  await live.loadReceptionistLiveData({
    baseUrl: "https://example.test",
    now: 1000,
    sources: ["facility"],
    attempts: 1,
    fetch: async () => response({ success: true, activity: { roomTemperatureF: 68, occupancyCount: 2 } }),
  });
  const partial = await live.loadReceptionistLiveData({
    baseUrl: "https://example.test",
    now: 62000,
    sources: ["facility"],
    attempts: 1,
    fetch: async () => response({ success: true, partial: true, unavailable: ["room_climate"], activity: { roomTemperatureF: null, occupancyCount: 3 } }),
  });
  assert.equal(partial.facility.freshness, "stale");
  assert.equal(partial.facility.data.activity.roomTemperatureF, 68);
  assert.equal(partial.facility.data.activity.occupancyCount, 3);
});

test("known live facts are answered directly from structured data", () => {
  const data = snapshot();
  assert.equal(
    receptionist.deterministicLiveAnswer({ live_fact: "temperature" }, data),
    "The latest gym temperature is 68 degrees Fahrenheit."
  );
  assert.equal(
    receptionist.deterministicLiveAnswer({ live_fact: "busiest_time" }, data),
    "Based on check-ins over the past 8 weeks, the gym's busiest recorded period is Sunday at 6:00 PM."
  );
  assert.equal(
    receptionist.deterministicLiveAnswer({ live_fact: "occupancy" }, data),
    "2 people are currently signed in at the gym."
  );
});

test("stale live readings are labeled as recorded rather than current", () => {
  assert.equal(
    receptionist.deterministicLiveAnswer({ live_fact: "temperature" }, snapshot("stale")),
    "The latest recorded gym temperature is 68 degrees Fahrenheit."
  );
});

test("missing partial live fields are never reported as zero", () => {
  const data = snapshot();
  data.facility.data.activity.roomTemperatureF = null;
  data.facility.data.activity.occupancyCount = null;
  assert.equal(receptionist.deterministicLiveAnswer({ live_fact: "temperature" }, data), "");
  assert.equal(receptionist.deterministicLiveAnswer({ live_fact: "occupancy" }, data), "");
});

test("answer generation retries with the fallback model and never emits the blanket apology", async () => {
  const models = [];
  const payloads = [];
  const answer = await receptionist.answer("Tell me about RORC.", [], "brief", {}, {
    apiKey: "test-key",
    liveSnapshot: snapshot(),
    fetch: async (_url, options) => {
      const payload = JSON.parse(options.body);
      const model = payload.model;
      payloads.push(payload);
      models.push(model);
      if (models.length === 1) return response({ error: { message: "primary unavailable" } }, false);
      return response({ choices: [{ message: { content: "RORC is a community recreation center in Bly, Oregon." } }] });
    },
  });
  assert.deepEqual(models, ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
  assert.equal(payloads[0].reasoning_effort, "low");
  assert.equal(payloads[0].max_completion_tokens, 622);
  assert.equal(payloads[0].max_tokens, undefined);
  assert.equal(answer, "RORC is a community recreation center in Bly, Oregon.");
  assert.doesNotMatch(answer, /sorry|try again/i);
});

test("answer generation never speaks an explicitly truncated model response", async () => {
  let attempts = 0;
  const generated = await receptionist.answer("Tell me about RORC.", [], "brief", {}, {
    apiKey: "test-key",
    liveSnapshot: snapshot(),
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) {
        return response({ choices: [{ finish_reason: "length", message: { content: "I don’t have" } }] });
      }
      return response({ choices: [{ finish_reason: "stop", message: { content: "RORC is a community recreation center in Bly, Oregon." } }] });
    },
  });
  assert.equal(attempts, 2);
  assert.equal(generated, "RORC is a community recreation center in Bly, Oregon.");
});
