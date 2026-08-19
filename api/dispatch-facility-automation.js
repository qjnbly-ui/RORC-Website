const gymLightsOnHandler = require("./gym-lights-on-sequence");
const gymLightsOffHandler = require("./gym-lights-off-sequence");

const SUPABASE_URL = String(
  process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co"
).replace(/\/+$/, "");
const SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const { isCronAuthorized } = require("./_automation-security");

function authorized(req) {
  return isCronAuthorized(req);
}

function requestOrigin(req) {
  const forwardedHost = String(req.headers?.["x-forwarded-host"] || "").split(",")[0].trim();
  const host = forwardedHost || String(req.headers?.host || "").trim();
  const forwardedProtocol = String(req.headers?.["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProtocol || "https";
  if (!host) throw new Error("Could not determine the facility automation origin.");
  return `${protocol}://${host}`;
}

function serviceHeaders(extra = {}) {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    ...extra
  };
}

async function claimFacilityAutomationJob(fetcher = fetch) {
  const response = await fetcher(`${SUPABASE_URL}/rest/v1/rpc/claim_facility_automation_job`, {
    method: "POST",
    headers: serviceHeaders({ "Content-Type": "application/json" }),
    body: "{}"
  });
  const body = await response.json().catch(() => []);
  if (!response.ok) {
    throw new Error(body?.message || body?.error || "Could not claim facility automation work.");
  }
  if (!Array.isArray(body)) throw new Error("Facility automation claim returned an invalid response.");
  return body[0] || null;
}

async function loadFacilityAutomationSnapshot(fetcher = fetch) {
  const response = await fetcher(`${SUPABASE_URL}/rest/v1/rpc/facility_automation_snapshot`, {
    method: "POST",
    headers: serviceHeaders({ "Content-Type": "application/json" }),
    body: "{}"
  });
  const body = await response.json().catch(() => []);
  if (!response.ok) {
    throw new Error(body?.message || body?.error || "Could not load facility occupancy state.");
  }
  const snapshot = Array.isArray(body) ? body[0] : body;
  if (!snapshot || typeof snapshot.is_occupied !== "boolean") {
    throw new Error("Facility occupancy state returned an invalid response.");
  }
  return {
    isOccupied: snapshot.is_occupied,
    transitionVersion: Number(snapshot.transition_version || 0)
  };
}

async function updateAutomationJob(id, patch, fetcher = fetch) {
  const response = await fetcher(
    `${SUPABASE_URL}/rest/v1/automation_jobs?id=eq.${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: serviceHeaders({
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      }),
      body: JSON.stringify(patch)
    }
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message || body?.error || "Could not update facility automation work.");
  }
}

function visitDurationMinutes(payload) {
  const signedInAt = Date.parse(String(payload?.signed_in_at || ""));
  const signedOutAt = Date.parse(String(payload?.signed_out_at || ""));
  if (!Number.isFinite(signedInAt) || !Number.isFinite(signedOutAt)) return 0;
  return Math.max(0, Math.round((signedOutAt - signedInAt) / 60000));
}

async function invokeSequence(handler, { origin, body, automationHooks }) {
  const url = new URL(origin);
  const response = {
    statusCode: 200,
    responseBody: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.responseBody = value;
      return this;
    }
  };
  await handler({
    method: "POST",
    headers: {
      host: url.host,
      authorization: `Bearer ${String(process.env.CRON_SECRET || "").trim()}`
    },
    body,
    automationHooks
  }, response);
  if (response.statusCode >= 400 || response.responseBody?.success === false) {
    const rawError = response.responseBody?.error;
    const message = typeof rawError === "string"
      ? rawError
      : rawError?.message || "Facility automation sequence failed.";
    const error = new Error(message);
    error.completedSteps = Array.isArray(response.responseBody?.completedSteps)
      ? response.responseBody.completedSteps
      : [];
    error.inFlightStep = response.responseBody?.inFlightStep || null;
    throw error;
  }
  return response.responseBody || { success: true };
}

async function dispatchFacilityAutomation({
  origin,
  fetcher = fetch,
  executeOn = (options) => invokeSequence(gymLightsOnHandler, options),
  executeOff = (options) => invokeSequence(gymLightsOffHandler, options),
  now = new Date()
} = {}) {
  const job = await claimFacilityAutomationJob(fetcher);
  if (!job) {
    return { claimedCount: 0, completedCount: 0, canceledCount: 0, failedCount: 0, results: [] };
  }

  const payload = job.payload || {};
  const jobVersion = Number(payload.transition_version || 0);
  let snapshot;
  try {
    snapshot = await loadFacilityAutomationSnapshot(fetcher);
  } catch (error) {
    const attempts = Number(job.attempts || 0);
    const retry = attempts < 3;
    await updateAutomationJob(job.id, {
      job_status: retry ? "pending" : "failed",
      run_after: retry
        ? new Date(now.getTime() + (Math.max(1, attempts) * 60000)).toISOString()
        : job.run_after,
      last_error: error.message || "Could not verify facility occupancy state."
    }, fetcher);
    return {
      claimedCount: 1,
      completedCount: 0,
      canceledCount: 0,
      failedCount: 1,
      results: [{
        id: job.id,
        status: retry ? "pending" : "failed",
        error: error.message || "Could not verify facility occupancy state."
      }]
    };
  }
  const expectedOccupied = job.kind === "voice_monkey_sign_in";
  const isCurrent = jobVersion > 0
    && jobVersion === snapshot.transitionVersion
    && expectedOccupied === snapshot.isOccupied;

  if (!isCurrent) {
    await updateAutomationJob(job.id, {
      job_status: "canceled",
      last_error: "Superseded by the current facility occupancy state."
    }, fetcher);
    return {
      claimedCount: 1,
      completedCount: 0,
      canceledCount: 1,
      failedCount: 0,
      results: [{ id: job.id, status: "canceled" }]
    };
  }

  try {
    const memberName = String(payload.member_name || payload.guest_name || "Unknown").trim() || "Unknown";
    const completedSteps = Array.isArray(payload.completed_steps) ? payload.completed_steps : [];
    const automationHooks = {
      beforeStep: async (step, steps) => updateAutomationJob(job.id, {
        payload: { ...payload, completed_steps: steps, in_flight_step: step }
      }, fetcher),
      afterStep: async (_step, steps) => updateAutomationJob(job.id, {
        payload: { ...payload, completed_steps: steps, in_flight_step: null }
      }, fetcher)
    };
    const sequenceResult = expectedOccupied
      ? await executeOn({
        origin,
        body: { memberName, ...(completedSteps.length ? { completedSteps } : {}) },
        automationHooks
      })
      : await executeOff({
        origin,
        body: {
          memberName,
          visitDurationMinutes: visitDurationMinutes(payload),
          ...(completedSteps.length ? { completedSteps } : {})
        },
        automationHooks
      });

    const finalSteps = Array.isArray(sequenceResult?.completedSteps)
      ? sequenceResult.completedSteps.map(String)
      : completedSteps;
    await updateAutomationJob(job.id, {
      job_status: "completed",
      last_error: null,
      payload: { ...payload, completed_steps: finalSteps, in_flight_step: null }
    }, fetcher);
    return {
      claimedCount: 1,
      completedCount: 1,
      canceledCount: 0,
      failedCount: 0,
      results: [{ id: job.id, status: "completed", sequenceResult }]
    };
  } catch (error) {
    const attempts = Number(job.attempts || 0);
    const inFlightStep = String(error?.inFlightStep || "").trim();
    const retry = !inFlightStep && attempts < 3;
    const completedSteps = Array.isArray(error?.completedSteps) ? error.completedSteps : [];
    await updateAutomationJob(job.id, {
      job_status: retry ? "pending" : "failed",
      run_after: retry
        ? new Date(now.getTime() + (Math.max(1, attempts) * 60000)).toISOString()
        : job.run_after,
      last_error: error.message || "Facility automation sequence failed.",
      payload: {
        ...payload,
        completed_steps: completedSteps,
        in_flight_step: inFlightStep || null
      }
    }, fetcher);
    return {
      claimedCount: 1,
      completedCount: 0,
      canceledCount: 0,
      failedCount: 1,
      results: [{
        id: job.id,
        status: retry ? "pending" : "failed",
        error: error.message || "Facility automation sequence failed."
      }]
    };
  }
}

async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }
  if (!authorized(req)) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, error: "Supabase service access is not configured" });
  }

  try {
    const result = await dispatchFacilityAutomation({ origin: requestOrigin(req) });
    return res.status(200).json({ success: true, ...result, completedAt: new Date().toISOString() });
  } catch (error) {
    console.error("Facility automation dispatch failed", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Facility automation dispatch failed"
    });
  }
}

module.exports = handler;
module.exports.authorized = authorized;
module.exports.claimFacilityAutomationJob = claimFacilityAutomationJob;
module.exports.dispatchFacilityAutomation = dispatchFacilityAutomation;
module.exports.loadFacilityAutomationSnapshot = loadFacilityAutomationSnapshot;
module.exports.requestOrigin = requestOrigin;
module.exports.visitDurationMinutes = visitDurationMinutes;
