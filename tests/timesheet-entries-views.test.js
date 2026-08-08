const assert = require("node:assert/strict");
const test = require("node:test");

process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";

const modulePath = require.resolve("../api/timesheet-entries");
const SPECIALIZED_READ_COLUMNS = [
  "id",
  "member_id",
  "member_or_guest",
  "guest_name",
  "day_pass_or_open_gym",
  "member_entered_with_id",
  "liability_accepted",
  "signed_in_at",
  "signed_out_at"
].join(",");

test("kiosk open view reads only the bounded open timesheet source", { concurrency: false }, async () => {
  const calls = [];
  const handler = freshHandler();

  await withFetch(async (url, options = {}) => {
    const path = String(url);
    calls.push({ path, options });
    if (path.includes("/auth/v1/user")) return jsonResponse({ id: "kiosk-auth" });
    if (path.includes("account_members?select=id,account_type&auth_user_id=")) {
      return jsonResponse([{ id: "kiosk-member", account_type: "Kiosk Account" }]);
    }
    if (path.includes("/timesheet_entries?")) {
      return jsonResponse([{ id: "open-1", signed_in_at: "2026-08-08T17:00:00.000Z", signed_out_at: null }]);
    }
    throw new Error(`Unexpected request: ${path}`);
  }, async () => {
    const response = await invoke(handler, { view: "open" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.deepEqual(response.body.entries.map((entry) => entry.id), ["open-1"]);
  });

  const sourceCalls = calls.filter((call) => call.path.includes("/timesheet_entries?"));
  assert.equal(sourceCalls.length, 1);
  const sourceUrl = new URL(sourceCalls[0].path);
  assert.equal(sourceUrl.searchParams.get("signed_out_at"), "is.null");
  assert.equal(sourceUrl.searchParams.get("order"), "signed_in_at.desc");
  assert.equal(sourceUrl.searchParams.get("limit"), "100");
  assert.equal(sourceUrl.searchParams.get("select"), SPECIALIZED_READ_COLUMNS);
});

test("kiosk sign-in view merges bounded open rows with the 24-hour Day Pass guest window", { concurrency: false }, async () => {
  const sourceUrls = [];
  const handler = freshHandler();
  const beforeRequest = Date.now();

  await withFetch(async (url) => {
    const path = String(url);
    if (path.includes("/auth/v1/user")) return jsonResponse({ id: "kiosk-auth" });
    if (path.includes("account_members?select=id,account_type&auth_user_id=")) {
      return jsonResponse([{ id: "kiosk-member", account_type: "Kiosk Account" }]);
    }
    if (path.includes("/timesheet_entries?")) {
      const parsed = new URL(path);
      sourceUrls.push(parsed);
      if (parsed.searchParams.get("signed_out_at") === "is.null") {
        return jsonResponse([
          { id: "open-1", signed_in_at: "2026-08-08T17:00:00.000Z", signed_out_at: null }
        ]);
      }
      return jsonResponse([
        { id: "guest-1", signed_in_at: "2026-08-08T18:00:00.000Z", signed_out_at: "2026-08-08T19:00:00.000Z" },
        { id: "open-1", signed_in_at: "2026-08-08T17:00:00.000Z", signed_out_at: null }
      ]);
    }
    throw new Error(`Unexpected request: ${path}`);
  }, async () => {
    const response = await invoke(handler, { view: "sign-in" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.deepEqual(response.body.entries.map((entry) => entry.id), ["guest-1", "open-1"]);
  });

  assert.equal(sourceUrls.length, 2);
  sourceUrls.forEach((url) => assert.equal(url.searchParams.get("limit"), "100"));
  sourceUrls.forEach((url) => assert.equal(url.searchParams.get("select"), SPECIALIZED_READ_COLUMNS));
  const guestUrl = sourceUrls.find((url) => url.searchParams.get("member_or_guest") === "eq.Guest");
  assert.ok(guestUrl);
  assert.equal(guestUrl.searchParams.get("day_pass_or_open_gym"), "eq.Day Pass");
  const threshold = Date.parse(String(guestUrl.searchParams.get("signed_in_at") || "").replace(/^gte\./, ""));
  assert.ok(Number.isFinite(threshold));
  assert.ok(Math.abs(threshold - (beforeRequest - (24 * 60 * 60 * 1000))) < 2000);
});

test("default kiosk GET preserves the recent-250 plus open-100 behavior", { concurrency: false }, async () => {
  const sourceUrls = [];
  const handler = freshHandler();

  await withFetch(async (url) => {
    const path = String(url);
    if (path.includes("/auth/v1/user")) return jsonResponse({ id: "kiosk-auth" });
    if (path.includes("account_members?select=id,account_type&auth_user_id=")) {
      return jsonResponse([{ id: "kiosk-member", account_type: "Kiosk Account" }]);
    }
    if (path.includes("/timesheet_entries?")) {
      const parsed = new URL(path);
      sourceUrls.push(parsed);
      return parsed.searchParams.get("limit") === "250"
        ? jsonResponse([{ id: "recent-1", signed_in_at: "2026-08-08T18:00:00.000Z" }])
        : jsonResponse([{ id: "open-1", signed_in_at: "2026-08-08T17:00:00.000Z" }]);
    }
    throw new Error(`Unexpected request: ${path}`);
  }, async () => {
    const response = await invoke(handler);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.deepEqual(response.body.entries.map((entry) => entry.id), ["recent-1", "open-1"]);
  });

  assert.equal(sourceUrls.length, 2);
  assert.ok(sourceUrls.some((url) => url.searchParams.get("select") === "*" && url.searchParams.get("limit") === "250"));
  assert.ok(sourceUrls.some((url) => url.searchParams.get("select") === "*" && url.searchParams.get("signed_out_at") === "is.null" && url.searchParams.get("limit") === "100"));
});

test("specialized timesheet views retain kiosk-only authorization", { concurrency: false }, async () => {
  const handler = freshHandler();
  let timesheetRead = false;

  await withFetch(async (url) => {
    const path = String(url);
    if (path.includes("/auth/v1/user")) return jsonResponse({ id: "manager-auth" });
    if (path.includes("account_members?select=id,account_type&auth_user_id=")) {
      return jsonResponse([{ id: "manager-member", account_type: "Account Manager" }]);
    }
    if (path.includes("/timesheet_entries?")) timesheetRead = true;
    throw new Error(`Unexpected request: ${path}`);
  }, async () => {
    const response = await invoke(handler, { view: "open" });
    assert.equal(response.statusCode, 403);
    assert.match(response.body.error, /Only kiosk accounts/);
  });

  assert.equal(timesheetRead, false);
});

test("specialized timesheet upstream failures preserve the HTTP error contract", { concurrency: false }, async () => {
  const handler = freshHandler();

  await withFetch(async (url) => {
    const path = String(url);
    if (path.includes("/auth/v1/user")) return jsonResponse({ id: "kiosk-auth" });
    if (path.includes("account_members?select=id,account_type&auth_user_id=")) {
      return jsonResponse([{ id: "kiosk-member", account_type: "Kiosk Account" }]);
    }
    if (path.includes("/timesheet_entries?")) return jsonResponse({ message: "temporarily unavailable" }, 503);
    throw new Error(`Unexpected request: ${path}`);
  }, async () => {
    const response = await invoke(handler, { view: "open" });
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.success, false);
    assert.match(response.body.error, /REST request failed: 503/);
  });
});

function freshHandler() {
  delete require.cache[modulePath];
  return require(modulePath);
}

async function withFetch(fetcher, callback) {
  const originalFetch = global.fetch;
  global.fetch = fetcher;
  try {
    return await callback();
  } finally {
    global.fetch = originalFetch;
    delete require.cache[modulePath];
  }
}

async function invoke(handler, query = {}) {
  const req = {
    method: "GET",
    headers: { authorization: "Bearer test-session" },
    query
  };
  const response = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
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
