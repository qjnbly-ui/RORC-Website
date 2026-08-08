const assert = require("node:assert/strict");
const test = require("node:test");

process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";

const modulePath = require.resolve("../api/member-directory");
const KIOSK_KEYS = [
  "account_id",
  "account_member_id",
  "account_number",
  "account_type",
  "allow_guest_entry",
  "allow_heater_use",
  "can_access_independently",
  "member_name"
].sort();

test("manager cache remains compatible and cannot leak private directory fields to kiosk responses", { concurrency: false }, async () => {
  const calls = [];
  const handler = freshHandler();

  await withFetch(async (url, options = {}) => {
    const path = String(url);
    calls.push(path);

    if (path.includes("/auth/v1/user")) {
      const token = String(options.headers?.Authorization || "");
      return jsonResponse({ id: token.includes("kiosk-session") ? "kiosk-auth" : "manager-auth" });
    }
    if (path.includes("account_members?select=id,account_type&auth_user_id=")) {
      return path.includes("kiosk-auth")
        ? jsonResponse([{ id: "kiosk-member", account_type: "Kiosk Account" }])
        : jsonResponse([{ id: "manager-member", account_type: "Account Manager" }]);
    }
    if (path.includes("/account_member_profiles?")) {
      return jsonResponse([privateDirectoryRow()]);
    }
    if (path.includes("/signup_contracts?")) {
      return jsonResponse([{
        account_id: "account-1",
        primary_member_id: "member-1",
        contract_payload: { primary: { address: "123 Private Street" } },
        created_at: "2026-08-08T12:00:00.000Z"
      }]);
    }
    throw new Error(`Unexpected request: ${path}`);
  }, async () => {
    const firstManagerResponse = await invoke(handler, "manager-session");
    assert.equal(firstManagerResponse.statusCode, 200);
    assert.equal(firstManagerResponse.body.success, true);
    assert.equal(firstManagerResponse.body.members[0].phone_number, "541-555-0100");
    assert.equal(firstManagerResponse.body.members[0].email_address, "private@example.com");
    assert.equal(firstManagerResponse.body.members[0].is_billing_owner, true);
    assert.equal(firstManagerResponse.body.members[0].mailing_address, "123 Private Street");

    const cachedManagerResponse = await invoke(handler, "manager-session");
    assert.equal(cachedManagerResponse.statusCode, 200);
    assert.equal(cachedManagerResponse.body.success, true);
    assert.equal(cachedManagerResponse.body.cached, true);
    assert.equal(cachedManagerResponse.body.members[0].phone_number, "541-555-0100");

    const firstKioskResponse = await invoke(handler, "kiosk-session");
    const secondKioskResponse = await invoke(handler, "kiosk-session");
    for (const response of [firstKioskResponse, secondKioskResponse]) {
      assert.equal(response.statusCode, 200);
      assert.equal(response.body.success, true);
      assert.equal(response.body.cached, undefined);
      assert.deepEqual(Object.keys(response.body.members[0]).sort(), KIOSK_KEYS);
      assert.deepEqual(response.body.members[0], {
        account_member_id: "member-1",
        account_id: "account-1",
        account_number: "42",
        member_name: "Private Member",
        account_type: "Active Membership",
        allow_guest_entry: true,
        allow_heater_use: true,
        can_access_independently: false
      });
    }
  });

  const profileCalls = calls.filter((path) => path.includes("/account_member_profiles?"));
  const managerProfileCalls = profileCalls.filter((path) => new URL(path).searchParams.get("select").includes("phone_number"));
  const kioskProfileCalls = profileCalls.filter((path) => !new URL(path).searchParams.get("select").includes("phone_number"));
  assert.equal(managerProfileCalls.length, 1);
  assert.equal(kioskProfileCalls.length, 2);
  kioskProfileCalls.forEach((path) => {
    const columns = new URL(path).searchParams.get("select");
    assert.doesNotMatch(columns, /phone_number|email_address|mailing_address|date_of_birth|guardian_member_id|is_billing_owner/);
  });
  assert.equal(calls.filter((path) => path.includes("/signup_contracts?")).length, 1);
});

test("kiosk directory fallback uses only base-table safe fields and skips billing and mailing hydration", { concurrency: false }, async () => {
  const calls = [];
  const handler = freshHandler();
  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    await withFetch(async (url) => {
      const path = String(url);
      calls.push(path);
      if (path.includes("/auth/v1/user")) return jsonResponse({ id: "kiosk-auth" });
      if (path.includes("account_members?select=id,account_type&auth_user_id=")) {
        return jsonResponse([{ id: "kiosk-member", account_type: "Kiosk Account" }]);
      }
      if (path.includes("/account_member_profiles?")) return jsonResponse({ message: "view unavailable" }, 500);
      if (path.includes("account_members?select=id,account_id,member_name")) {
        return jsonResponse([{
          id: "member-2",
          account_id: "account-2",
          member_name: "Fallback Member",
          account_type: "Weight Room Only",
          allow_guest_entry: false,
          allow_heater_use: true,
          can_access_independently: true
        }]);
      }
      if (path.includes("accounts?select=id,account_number")) {
        return jsonResponse([{ id: "account-2", account_number: "77" }]);
      }
      throw new Error(`Unexpected request: ${path}`);
    }, async () => {
      const response = await invoke(handler, "kiosk-session");
      assert.equal(response.statusCode, 200);
      assert.equal(response.body.success, true);
      assert.match(response.body.warning, /fallback tables/i);
      assert.deepEqual(Object.keys(response.body.members[0]).sort(), KIOSK_KEYS);
      assert.equal(response.body.members[0].account_number, "77");
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(calls.some((path) => path.includes("/account_billing?")), false);
  assert.equal(calls.some((path) => path.includes("/signup_contracts?")), false);
  const memberSource = calls.find((path) => path.includes("account_members?select=id,account_id,member_name"));
  assert.ok(memberSource);
  assert.doesNotMatch(new URL(memberSource).searchParams.get("select"), /phone_number|email_address|date_of_birth|guardian_member_id|is_billing_owner/);
});

test("ordinary members cannot read the directory or trigger a directory source query", { concurrency: false }, async () => {
  const handler = freshHandler();
  let directoryRead = false;

  await withFetch(async (url) => {
    const path = String(url);
    if (path.includes("/auth/v1/user")) return jsonResponse({ id: "ordinary-auth" });
    if (path.includes("account_members?select=id,account_type&auth_user_id=")) {
      return jsonResponse([{ id: "ordinary-member", account_type: "Active Membership" }]);
    }
    directoryRead = true;
    throw new Error(`Unexpected request: ${path}`);
  }, async () => {
    const response = await invoke(handler, "ordinary-session");
    assert.equal(response.statusCode, 403);
    assert.equal(response.body.success, false);
    assert.match(response.body.error, /Only account managers and kiosk accounts/);
  });

  assert.equal(directoryRead, false);
});

for (const role of ["Kiosk Account", "Account Manager"]) {
  test(`${role} receives 503 when both directory sources are unavailable`, { concurrency: false }, async () => {
    const handler = freshHandler();
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = () => {};
    console.error = () => {};

    try {
      await withFetch(async (url) => {
        const path = String(url);
        if (path.includes("/auth/v1/user")) return jsonResponse({ id: "authorized-auth" });
        if (path.includes("account_members?select=id,account_type&auth_user_id=")) {
          return jsonResponse([{ id: "authorized-member", account_type: role }]);
        }
        if (path.includes("/account_member_profiles?")) {
          return jsonResponse({ message: "profile view unavailable" }, 503);
        }
        if (path.includes("account_members?select=id,account_id,member_name")) {
          return jsonResponse({ message: "member table unavailable" }, 503);
        }
        if (path.includes("accounts?select=id,account_number")) {
          return jsonResponse({ message: "account table unavailable" }, 503);
        }
        if (path.includes("account_billing?")) {
          return jsonResponse({ message: "billing table unavailable" }, 503);
        }
        throw new Error(`Unexpected request: ${path}`);
      }, async () => {
        const response = await invoke(handler, "authorized-session");
        assert.equal(response.statusCode, 503);
        assert.deepEqual(response.body, {
          success: false,
          error: "Member directory is temporarily unavailable. Please try again."
        });
      });
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
    }
  });
}

function privateDirectoryRow() {
  return {
    account_member_id: "member-1",
    account_id: "account-1",
    account_number: "42",
    member_name: "Private Member",
    account_type: "Active Membership",
    legacy_account_type: "Legacy",
    phone_number: "541-555-0100",
    email_address: "private@example.com",
    image_path: "/private-image.png",
    allow_guest_entry: true,
    is_billing_owner: true,
    allow_heater_use: true,
    date_of_birth: "2000-01-01",
    guardian_member_id: "guardian-1",
    can_access_independently: false,
    stripe_status: "active",
    billing_status: "active"
  };
}

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

async function invoke(handler, token) {
  const req = {
    method: "GET",
    headers: { authorization: `Bearer ${token}` }
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
