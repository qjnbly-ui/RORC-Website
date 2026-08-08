const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.TWILIO_FROM_NUMBER = "+15416526065";

const communications = require("../api/_staff-communications");
const { optedOutPhoneSet } = require("../api/_rorc-sms");

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data
  };
}

test("incoming Twilio media is normalized into a private attachment list", () => {
  const media = communications.parseInboundMedia({
    NumMedia: "2",
    MediaUrl0: "https://api.twilio.com/media/one",
    MediaContentType0: "image/jpeg",
    MediaUrl1: "https://api.twilio.com/media/two",
    MediaContentType1: "image/png"
  });
  assert.deepEqual(media, [
    { url: "https://api.twilio.com/media/one", contentType: "image/jpeg" },
    { url: "https://api.twilio.com/media/two", contentType: "image/png" }
  ]);
});

test("staff communications authorization permits only account managers", async () => {
  const requests = [];
  const manager = await communications.requireAccountManager({
    headers: { authorization: "Bearer staff-session" }
  }, async (url, options) => {
    requests.push({ url, options });
    if (url.includes("/auth/v1/user")) return jsonResponse({ id: "auth-user-1" });
    return jsonResponse([{ id: "member-1", member_name: "Manager", account_type: "Account Manager" }]);
  });
  assert.equal(manager.id, "member-1");
  assert.match(requests[1].url, /auth_user_id=eq\.auth-user-1/);
});

test("ordinary inbound SMS is recorded in the separate staff inbox", async () => {
  let rpcPayload = null;
  const result = await communications.recordIncomingMessage({
    From: "+1 (541) 555-0100",
    To: "+15416526065",
    MessageSid: "SM123",
    Body: "Can someone call me?",
    NumMedia: "0"
  }, async (url, options) => {
    assert.match(url, /\/rest\/v1\/rpc\/record_staff_communication_message$/);
    rpcPayload = JSON.parse(options.body);
    return jsonResponse([{ message_id: "message-1", thread_id: "thread-1" }]);
  });
  assert.deepEqual(result, { message_id: "message-1", thread_id: "thread-1" });
  assert.equal(rpcPayload.p_phone_e164, "+15415550100");
  assert.equal(rpcPayload.p_direction, "inbound");
  assert.equal(rpcPayload.p_body, "Can someone call me?");
  assert.equal(rpcPayload.p_message_status, "received");
});

test("SMS preferences match opted-out phone numbers to member names", async () => {
  const result = await communications.listSmsPreferences(async (url) => {
    if (url.includes("rorc_receptionist_sms_consent")) {
      return jsonResponse([
        {
          phone_e164: "+15415550100",
          consent_status: "opt_out",
          consent_source: "inbound_sms",
          opted_out_at: "2026-08-08T18:00:00.000Z",
          updated_at: "2026-08-08T18:00:00.000Z"
        }
      ]);
    }
    return jsonResponse([
      {
        id: "member-1",
        member_name: "Example Member",
        account_type: "Full Facility Membership",
        phone_number: "(541) 555-0100"
      }
    ]);
  });

  assert.equal(result.summary.optedOut, 1);
  assert.equal(result.preferences[0].phone, "+15415550100");
  assert.equal(result.preferences[0].members[0].name, "Example Member");
});

test("bulk SMS opt-out lookup returns only requested opted-out phones", async () => {
  const optedOut = await optedOutPhoneSet([
    "(541) 555-0100",
    "+15415550101"
  ], async (url) => {
    assert.match(url, /consent_status=eq\.opt_out/);
    return jsonResponse([
      { phone_e164: "+15415550100" },
      { phone_e164: "+15415550999" }
    ]);
  });

  assert.deepEqual([...optedOut], ["+15415550100"]);
});
