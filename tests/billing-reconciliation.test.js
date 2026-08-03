const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

test("Stripe refresh exposes a local-paid mismatch and offline payment closes the existing invoice", async () => {
  const calls = [];
  const billingRows = [
    {
      id: "item-rental",
      account_member_id: "member-1",
      rental_request_id: "rental-1",
      amount_cents: 21000,
      reason: "Rental",
      posted_to_stripe_at: "2026-08-02T23:30:00.000Z",
      payment_method: "check",
      stripe_invoice_id: "in_open",
      stripe_invoice_status: "open"
    },
    {
      id: "item-ac",
      account_member_id: "member-1",
      rental_request_id: "rental-1",
      heater_use_entry_id: "heater-1",
      amount_cents: 654,
      reason: "AC use",
      posted_to_stripe_at: "2026-08-02T23:30:00.000Z",
      payment_method: "check",
      stripe_invoice_id: "in_open",
      stripe_invoice_status: "open"
    }
  ];

  let stripeInvoice = {
    id: "in_open",
    status: "open",
    total: 21654,
    hosted_invoice_url: "https://invoice.stripe.test/in_open",
    customer: "cus_1",
    metadata: {},
    status_transitions: {}
  };
  const fakeStripe = {
    invoices: {
      retrieve: async (id) => {
        assert.equal(id, "in_open");
        return { ...stripeInvoice };
      },
      update: async (id, patch) => {
        assert.equal(id, "in_open");
        stripeInvoice = { ...stripeInvoice, metadata: patch.metadata };
        return { ...stripeInvoice };
      },
      pay: async (id, options) => {
        assert.equal(id, "in_open");
        assert.deepEqual(options, { paid_out_of_band: true });
        stripeInvoice = {
          ...stripeInvoice,
          status: "paid",
          paid_out_of_band: true,
          status_transitions: { paid_at: 1785715200 }
        };
        return { ...stripeInvoice };
      }
    }
  };

  const originalLoad = Module._load;
  Module._load = function loadWithFakeStripe(request, parent, isMain) {
    if (request === "stripe") return () => fakeStripe;
    return originalLoad.call(this, request, parent, isMain);
  };
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
  process.env.STRIPE_SECRET_KEY = "test-stripe-key";
  const modulePath = require.resolve("../api/create-stripe-invoice");
  delete require.cache[modulePath];
  const handler = require(modulePath);
  Module._load = originalLoad;

  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const path = String(url);
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, method, body });

    if (path.includes("/auth/v1/user")) return jsonResponse({ id: "auth-user" });
    if (path.includes("account_members?select=id,account_type&auth_user_id=")) {
      return jsonResponse([{ id: "manager-1", account_type: "Account Manager" }]);
    }
    if (path.includes("billing_line_items?select=*&id=in.")) return jsonResponse(billingRows);
    if (path.includes("billing_line_items?select=*&stripe_invoice_id=eq.")) return jsonResponse(billingRows);
    if (path.includes("account_members?select=id,account_id&id=in.")) {
      return jsonResponse([{ id: "member-1", account_id: "account-1" }]);
    }
    if (path.includes("billing_line_items?select=id,rental_request_id")) return jsonResponse(billingRows);
    if (path.includes("billing_line_items?select=id,heater_use_entry_id")) return jsonResponse(billingRows);
    if (method === "PATCH" && path.includes("billing_line_items?id=in.")) {
      billingRows.forEach((row) => Object.assign(row, body));
      return jsonResponse(null, 204);
    }
    if (method === "PATCH" && (path.includes("rental_requests?id=in.") || path.includes("heater_use_entries?id=in."))) {
      return jsonResponse(null, 204);
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  };

  try {
    const syncResponse = await invoke(handler, {
      billingLineItemIds: billingRows.map((row) => row.id),
      mode: "sync"
    });
    assert.equal(syncResponse.statusCode, 200);
    assert.equal(billingRows[0].posted_to_stripe_at, null);
    assert.equal(billingRows[0].stripe_invoice_status, "open");
    assert.ok(calls.some((call) => call.body?.payment_status === "unpaid"));

    const paidResponse = await invoke(handler, {
      billingLineItemIds: billingRows.map((row) => row.id),
      mode: "paid",
      paymentMethod: "check",
      paymentNote: "Check 1042"
    });
    assert.equal(paidResponse.statusCode, 200);
    assert.equal(paidResponse.body.invoices[0].status, "paid");
    assert.equal(billingRows[0].stripe_invoice_status, "paid");
    assert.equal(billingRows[0].payment_method, "check");
    assert.equal(billingRows[0].payment_note, "Check 1042");
    assert.ok(billingRows[0].posted_to_stripe_at);
    assert.ok(calls.some((call) => call.body?.payment_status === "paid"));
    assert.ok(calls.some((call) => call.body?.paid === true));
  } finally {
    global.fetch = originalFetch;
    delete require.cache[modulePath];
  }
});

async function invoke(handler, body) {
  const req = {
    method: "POST",
    headers: { authorization: "Bearer test-session" },
    body
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
