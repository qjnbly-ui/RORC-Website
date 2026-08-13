const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
const eventsHandler = require("../api/events");

test("public rentals still reserve rental availability", async () => {
  const originalFetch = global.fetch;
  const publicRental = {
    event_date: "2026-09-12",
    event_start_time: "07:00",
    event_end_time: "21:00",
    rental_type: "all_day",
    is_private_event: false,
    addon_early_setup: false,
    addon_early_day_rental: false,
    addon_late_cleanup: false,
    addon_late_day_rental: false
  };
  const privateRental = {
    ...publicRental,
    event_date: "2026-09-13",
    event_start_time: "10:00",
    event_end_time: "12:00",
    rental_type: "hourly",
    is_private_event: true
  };

  global.fetch = async (url) => {
    const requestUrl = String(url);
    if (requestUrl.includes("automation_settings?")) {
      return jsonResponse([{ config: { facility_start: "07:00", facility_end: "21:00" } }]);
    }
    if (requestUrl.includes("/events?")) return jsonResponse([]);
    if (requestUrl.includes("/rental_requests?")) return jsonResponse([publicRental, privateRental]);
    throw new Error(`Unexpected request: ${requestUrl}`);
  };

  try {
    const response = await invoke(eventsHandler, { method: "GET", query: { booked: "true" } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body.dates, ["2026-09-12"]);
    assert.deepEqual(response.body.blocks, [
      { date: "2026-09-12", start: "07:00", end: "21:00", eventType: "rental" },
      { date: "2026-09-13", start: "10:00", end: "12:00", eventType: "rental" }
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("public calendar responses identify non-private rentals and omit them from facility blocks", async () => {
  const originalFetch = global.fetch;
  const publicRental = {
    event_date: "2026-09-12",
    event_start_time: "09:00",
    event_end_time: "13:00",
    rental_type: "hourly",
    is_private_event: false,
    addon_early_setup: false,
    addon_early_day_rental: false,
    addon_late_cleanup: false,
    addon_late_day_rental: false
  };

  global.fetch = async (url) => {
    const requestUrl = String(url);
    if (requestUrl.includes("automation_settings?")) {
      return jsonResponse([{ config: { facility_start: "07:00", facility_end: "21:00" } }]);
    }
    if (requestUrl.includes("calendar_event_requests?")) return jsonResponse([]);
    if (requestUrl.includes("/rental_requests?")) return jsonResponse([publicRental]);
    if (requestUrl.includes("event_type=in.(rental,maintenance)")) return jsonResponse([]);
    if (requestUrl.includes("is_public=eq.true")) {
      return jsonResponse([{
        id: "event-public-rental",
        title: "Community Dinner",
        description: null,
        event_type: "rental",
        start_at: "2026-09-12T09:00:00",
        end_at: "2026-09-12T13:00:00",
        all_day: false,
        is_public: true,
        status: "confirmed",
        rental_request_id: "rental-public",
        rental_requests: publicRental,
        created_by: "system:rental:rental-public:calendar:main",
        created_at: "2026-08-13T12:00:00Z",
        updated_at: "2026-08-13T12:00:00Z"
      }]);
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  };

  try {
    const response = await invoke(eventsHandler, { method: "GET", query: {} });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.events[0].isPrivateEvent, false);
    assert.deepEqual(response.body.facilityBlocks, []);
  } finally {
    global.fetch = originalFetch;
  }
});

test("calendar open-window rendering ignores non-private rental events", () => {
  const appJs = fs.readFileSync(path.join(__dirname, "..", "RORC App", "app.js"), "utf8");
  assert.match(appJs, /ev\.eventType === "rental" && ev\.isPrivateEvent === false\) return null/);
});

async function invoke(handler, { method, query }) {
  const req = { method, query, headers: {} };
  const response = {
    statusCode: 200,
    body: null,
    setHeader() {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    }
  };
  await handler(req, response);
  return response;
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => payload == null ? "" : JSON.stringify(payload)
  };
}
