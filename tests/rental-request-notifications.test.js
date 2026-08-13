const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

test("new rental requests preserve the configured email alert and add Quentin's text alert", async () => {
  const previousEnv = {
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    resendKey: process.env.RESEND_API_KEY,
    notifyEmail: process.env.RORC_NOTIFY_EMAIL,
    rentalNotifyEmail: process.env.RORC_RENTAL_NOTIFY_EMAIL,
    rentalNotifyPhone: process.env.RORC_RENTAL_NOTIFY_PHONE
  };
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
  process.env.RESEND_API_KEY = "test-resend-key";
  process.env.RORC_NOTIFY_EMAIL = "quentin.nichols@ruthobenchainrc.com";
  delete process.env.RORC_RENTAL_NOTIFY_EMAIL;
  delete process.env.RORC_RENTAL_NOTIFY_PHONE;

  const sentEmails = [];
  const sentTexts = [];
  const originalLoad = Module._load;
  Module._load = function loadRentalNotificationMocks(request, parent, isMain) {
    if (parent?.filename?.endsWith("/api/rental-request.js") && request === "./_resend") {
      return {
        sendResendEmail: async (payload) => {
          sentEmails.push(payload);
          return { id: "email-1" };
        }
      };
    }
    if (parent?.filename?.endsWith("/api/rental-request.js") && request === "./_rorc-sms") {
      return {
        sendSms: async (to, body) => {
          sentTexts.push({ to, body });
          return { sid: "sms-1" };
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const modulePath = require.resolve("../api/rental-request");
  delete require.cache[modulePath];
  const handler = require(modulePath);
  Module._load = originalLoad;

  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const requestUrl = String(url);
    const method = options.method || "GET";
    if (requestUrl.includes("automation_settings?")) {
      return jsonResponse([{ config: { facility_start: "07:00", facility_end: "21:00" } }]);
    }
    if (method === "GET" && requestUrl.includes("/events?")) return jsonResponse([]);
    if (method === "GET" && requestUrl.includes("/rental_requests?")) return jsonResponse([]);
    if (method === "POST" && requestUrl.endsWith("/rest/v1/rental_requests")) {
      return jsonResponse([{
        ...JSON.parse(options.body),
        id: "rental-1",
        booking_number: "RORC-2026-0042",
        created_at: "2026-08-13T12:00:00Z"
      }]);
    }
    throw new Error(`Unexpected request: ${method} ${requestUrl}`);
  };

  try {
    const response = await invoke(handler, validRentalRequest());
    assert.equal(response.statusCode, 200);
    assert.deepEqual(sentEmails.map((email) => email.to), [["quentin.nichols@ruthobenchainrc.com"]]);
    assert.equal(sentTexts.length, 1);
    assert.equal(sentTexts[0].to, "+15418916772");
    assert.match(sentTexts[0].body, /RORC-2026-0042/);
    assert.match(sentTexts[0].body, /Community Dinner/);
  } finally {
    global.fetch = originalFetch;
    delete require.cache[modulePath];
    restoreEnv("SUPABASE_SERVICE_ROLE_KEY", previousEnv.serviceKey);
    restoreEnv("RESEND_API_KEY", previousEnv.resendKey);
    restoreEnv("RORC_NOTIFY_EMAIL", previousEnv.notifyEmail);
    restoreEnv("RORC_RENTAL_NOTIFY_EMAIL", previousEnv.rentalNotifyEmail);
    restoreEnv("RORC_RENTAL_NOTIFY_PHONE", previousEnv.rentalNotifyPhone);
  }
});

function validRentalRequest() {
  return {
    contactName: "Jamie Example",
    contactPhone: "541-555-0123",
    contactEmail: "jamie@example.com",
    contactAddress: "123 Main St",
    eventName: "Community Dinner",
    eventType: "Meeting",
    eventDate: "2026-09-12",
    eventStartTime: "09:00",
    eventEndTime: "13:00",
    publicEventStartTime: "10:00",
    publicEventEndTime: "12:00",
    estimatedAttendance: 40,
    foodOrDrinks: true,
    alcohol: "No",
    isPrivateEvent: false,
    rentalType: "hourly",
    agreedToNoGuarantee: true,
    agreedToGuidelines: true
  };
}

async function invoke(handler, body) {
  const req = { method: "POST", body, headers: {} };
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

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
