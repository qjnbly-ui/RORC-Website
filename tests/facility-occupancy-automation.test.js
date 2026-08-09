const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const modulePath = require.resolve("../api/dispatch-facility-automation.js");
const {
  authorized,
  dispatchFacilityAutomation,
  visitDurationMinutes
} = require(modulePath);

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

function facilityFetcher({ job, snapshot }) {
  const patches = [];
  const fetcher = async (url, options = {}) => {
    const requestUrl = String(url);
    if (requestUrl.includes("/rpc/claim_facility_automation_job")) {
      return jsonResponse(job ? [job] : []);
    }
    if (requestUrl.includes("/rpc/facility_automation_snapshot")) {
      return jsonResponse([snapshot]);
    }
    if (requestUrl.includes("/automation_jobs?") && options.method === "PATCH") {
      patches.push(JSON.parse(options.body));
      return jsonResponse(null, 204);
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  };
  return { fetcher, patches };
}

test("facility automation cron requires the exact bearer secret", () => {
  const prior = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "facility-cron-secret";
  try {
    assert.equal(authorized({ headers: { authorization: "Bearer facility-cron-secret" } }), true);
    assert.equal(authorized({ headers: { authorization: "Bearer wrong" } }), false);
    assert.equal(authorized({ headers: {} }), false);
  } finally {
    if (prior === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prior;
  }
});

test("the current first-in transition runs once and completes its claimed job", async () => {
  const calls = [];
  const job = {
    id: "job-in",
    kind: "voice_monkey_sign_in",
    attempts: 1,
    payload: { transition_version: 8, member_name: "Alex Member" }
  };
  const { fetcher, patches } = facilityFetcher({
    job,
    snapshot: { is_occupied: true, transition_version: 8 }
  });

  const result = await dispatchFacilityAutomation({
    origin: "https://example.test",
    fetcher,
    executeOn: async (options) => {
      calls.push(options);
      return { success: true };
    },
    executeOff: async () => { throw new Error("off should not run"); }
  });

  assert.equal(result.completedCount, 1);
  assert.deepEqual(calls, [{
    origin: "https://example.test",
    body: { memberName: "Alex Member" }
  }]);
  assert.deepEqual(patches, [{ job_status: "completed", last_error: null }]);
});

test("a stale kiosk transition is canceled without touching facility equipment", async () => {
  let sequenceCalls = 0;
  const { fetcher, patches } = facilityFetcher({
    job: {
      id: "stale-job",
      kind: "voice_monkey_sign_out",
      attempts: 1,
      payload: { transition_version: 4, member_name: "Old Exit" }
    },
    snapshot: { is_occupied: true, transition_version: 5 }
  });

  const result = await dispatchFacilityAutomation({
    origin: "https://example.test",
    fetcher,
    executeOn: async () => { sequenceCalls += 1; },
    executeOff: async () => { sequenceCalls += 1; }
  });

  assert.equal(result.canceledCount, 1);
  assert.equal(sequenceCalls, 0);
  assert.equal(patches[0].job_status, "canceled");
});

test("last-out transition passes the authoritative visit duration", async () => {
  const calls = [];
  const { fetcher } = facilityFetcher({
    job: {
      id: "job-out",
      kind: "voice_monkey_sign_out",
      attempts: 1,
      payload: {
        transition_version: 12,
        member_name: "Last Member",
        signed_in_at: "2026-08-09T18:00:00.000Z",
        signed_out_at: "2026-08-09T19:35:00.000Z"
      }
    },
    snapshot: { is_occupied: false, transition_version: 12 }
  });

  const result = await dispatchFacilityAutomation({
    origin: "https://example.test",
    fetcher,
    executeOn: async () => { throw new Error("on should not run"); },
    executeOff: async (options) => {
      calls.push(options);
      return { success: true };
    }
  });

  assert.equal(result.completedCount, 1);
  assert.equal(calls[0].body.visitDurationMinutes, 95);
  assert.equal(visitDurationMinutes({
    signed_in_at: "2026-08-09T18:00:00.000Z",
    signed_out_at: "2026-08-09T19:35:00.000Z"
  }), 95);
});

test("a failed sequence is left pending for a bounded retry", async () => {
  const now = new Date("2026-08-09T20:00:00.000Z");
  const { fetcher, patches } = facilityFetcher({
    job: {
      id: "retry-job",
      kind: "voice_monkey_sign_in",
      attempts: 1,
      run_after: "2026-08-09T19:59:00.000Z",
      payload: { transition_version: 15, member_name: "Retry Member" }
    },
    snapshot: { is_occupied: true, transition_version: 15 }
  });

  const result = await dispatchFacilityAutomation({
    origin: "https://example.test",
    fetcher,
    now,
    executeOn: async () => { throw new Error("temporary outage"); }
  });

  assert.equal(result.failedCount, 1);
  assert.equal(result.results[0].status, "pending");
  assert.equal(patches[0].job_status, "pending");
  assert.equal(patches[0].run_after, "2026-08-09T20:01:00.000Z");
  assert.match(patches[0].last_error, /temporary outage/);
});

test("database transition logic serializes kiosks and the browser no longer drives sequences", () => {
  const migration = fs.readFileSync(
    path.resolve(__dirname, "..", "supabase", "migrations", "20260809222121_serialize_facility_occupancy_automation.sql"),
    "utf8"
  );
  const app = fs.readFileSync(path.resolve(__dirname, "..", "RORC App", "app.js"), "utf8");
  assert.match(migration, /facility_occupancy_state[\s\S]*for update/i);
  assert.match(migration, /transition_version = transition_version \+ 1/i);
  assert.match(migration, /for update skip locked/i);
  assert.doesNotMatch(app, /\/api\/gym-lights-(?:on|off)-sequence/);
});

test("Vercel dispatches authoritative facility automation every minute", () => {
  const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "vercel.json"), "utf8"));
  assert.ok(config.crons.some((cron) => (
    cron.path === "/api/dispatch-facility-automation" && cron.schedule === "* * * * *"
  )));
});
