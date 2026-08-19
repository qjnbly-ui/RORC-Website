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
  assert.equal(calls[0].origin, "https://example.test");
  assert.deepEqual(calls[0].body, { memberName: "Alex Member" });
  assert.equal(typeof calls[0].automationHooks.beforeStep, "function");
  assert.deepEqual(patches, [{
    job_status: "completed",
    last_error: null,
    payload: {
      transition_version: 8,
      member_name: "Alex Member",
      completed_steps: [],
      in_flight_step: null
    }
  }]);
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

test("a retry checkpoints completed stages and resumes without repeating them", async () => {
  const now = new Date("2026-08-09T20:00:00.000Z");
  const job = {
    id: "partial-job",
    kind: "voice_monkey_sign_in",
    attempts: 1,
    run_after: "2026-08-09T19:59:00.000Z",
    payload: { transition_version: 16, member_name: "Partial Member" }
  };
  const first = facilityFetcher({
    job,
    snapshot: { is_occupied: true, transition_version: 16 }
  });
  const partialError = new Error("Step 3 failed");
  partialError.completedSteps = ["announcement", "lights"];

  await dispatchFacilityAutomation({
    origin: "https://example.test",
    fetcher: first.fetcher,
    now,
    executeOn: async () => { throw partialError; }
  });

  assert.deepEqual(first.patches[0].payload.completed_steps, ["announcement", "lights"]);

  const retryCalls = [];
  const second = facilityFetcher({
    job: { ...job, attempts: 2, payload: first.patches[0].payload },
    snapshot: { is_occupied: true, transition_version: 16 }
  });
  const result = await dispatchFacilityAutomation({
    origin: "https://example.test",
    fetcher: second.fetcher,
    executeOn: async (options) => {
      retryCalls.push(options);
      return { success: true };
    }
  });

  assert.equal(result.completedCount, 1);
  assert.deepEqual(retryCalls[0].body.completedSteps, ["announcement", "lights"]);
});

test("an ambiguous external action is failed instead of automatically repeated", async () => {
  const { fetcher, patches } = facilityFetcher({
    job: {
      id: "ambiguous-job",
      kind: "voice_monkey_sign_in",
      attempts: 1,
      payload: { transition_version: 17, member_name: "Safe Member" }
    },
    snapshot: { is_occupied: true, transition_version: 17 }
  });
  const error = new Error("provider response was lost");
  error.inFlightStep = "announcement";
  error.completedSteps = [];

  const result = await dispatchFacilityAutomation({
    origin: "https://example.test",
    fetcher,
    executeOn: async () => { throw error; }
  });

  assert.equal(result.results[0].status, "failed");
  assert.equal(patches[0].job_status, "failed");
  assert.equal(patches[0].payload.in_flight_step, "announcement");
});

test("gym opening sends SMS directly instead of calling the deployment recursively", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "..", "api", "gym-lights-on-sequence.js"), "utf8");
  assert.match(source, /api\.twilio\.com/);
  assert.doesNotMatch(source, /\/api\/send-gym-open-text/);
});

test("automation hardening removes source secrets and protects physical endpoints", () => {
  const files = [
    "gym-lights-on-sequence.js",
    "gym-lights-off-sequence.js",
    "gym-lights-mode.js"
  ].map((name) => fs.readFileSync(path.resolve(__dirname, "..", "api", name), "utf8"));
  assert.ok(files.slice(0, 2).every((source) => /requireCronAuthorization/.test(source)));
  assert.match(files[2], /requireFacilityOperator/);
  assert.ok(files.every((source) => !/token=[a-f0-9]{20,}/i.test(source)));
  assert.equal(fs.existsSync(path.resolve(__dirname, "..", "api", "send-gym-open-text.js")), false);
  const settingsApi = fs.readFileSync(path.resolve(__dirname, "..", "api", "automation-settings.js"), "utf8");
  assert.match(settingsApi, /preserveProtectedAutomationFields/);
  assert.match(settingsApi, /manual_half_lights_off_url/);
  assert.match(settingsApi, /manual_half_lights_off_v3_device/);
});

test("kiosk writes immediately drain the durable queue instead of waiting for cron", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "..", "api", "timesheet-entries.js"), "utf8");
  assert.match(source, /flushFacilityAutomation\(req\)/);
  assert.match(source, /dispatchFacilityAutomation/);
  assert.match(source, /cron fallback remains active/i);
});

test("queue migration atomically claims scheduled work and retires dead producers", () => {
  const migration = fs.readFileSync(
    path.resolve(__dirname, "..", "supabase", "migrations", "20260818151010_harden_automation_queues.sql"),
    "utf8"
  );
  assert.match(migration, /claim_scheduled_member_message[\s\S]*for update skip locked/i);
  assert.match(migration, /manual review[\s\S]*in_flight_step/i);
  assert.match(migration, /drop trigger if exists trg_enqueue_heater_insert_automation/i);
  assert.match(migration, /drop trigger if exists trg_enqueue_rental_request_notification/i);
  assert.match(migration, /drop trigger if exists trg_enqueue_timesheet_insert_automation/i);
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
