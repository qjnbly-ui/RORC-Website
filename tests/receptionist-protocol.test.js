const test = require("node:test");
const assert = require("node:assert/strict");
const { parseRelayMessage, sendApprovedHandoff, sendRelayText } = require("../.build/receptionist/protocol");
const { initializeCallSocket } = require("../.build/receptionist/state");
const twilio = require("twilio");
const { WebSocket } = require("ws");

test("ConversationRelay protocol accepts valid setup, prompt, and fragmented frames", () => {
  assert.deepEqual(parseRelayMessage(Buffer.from('{"type":"setup","callSid":"CA123"}')), { type: "setup", callSid: "CA123" });
  assert.deepEqual(parseRelayMessage(Buffer.from('{"type":"prompt","voicePrompt":"hello","last":true}')), { type: "prompt", voicePrompt: "hello", last: true });
  assert.deepEqual(parseRelayMessage([Buffer.from('{"type":"error",'), Buffer.from('"description":"relay reset"}')]), { type: "error", description: "relay reset" });
});

test("ConversationRelay protocol rejects malformed or untyped frames", () => {
  assert.equal(parseRelayMessage(Buffer.from("not json")), null);
  assert.equal(parseRelayMessage(Buffer.from("[]")), null);
  assert.equal(parseRelayMessage(Buffer.from('{"voicePrompt":"hello"}')), null);
});

test("outbound speech uses the ConversationRelay text contract", () => {
  const sent = [];
  sendRelayText({ send: (payload) => sent.push(JSON.parse(payload)) }, "The gym is 68 degrees.");
  assert.deepEqual(sent, [{
    type: "text",
    token: "The gym is 68 degrees.",
    last: true,
    interruptible: true,
    preemptible: true,
  }]);
});

test("handoffs are explicitly approved and carry a useful summary", () => {
  const sent = [];
  sendApprovedHandoff({ send: (payload) => sent.push(JSON.parse(payload)) }, "Caller needs rental help.");
  assert.equal(sent[0].type, "end");
  assert.deepEqual(JSON.parse(sent[0].handoffData), {
    reasonCode: "approved-rorc-transfer",
    summary: "Caller needs rental help.",
  });
});

test("each call starts with isolated state", () => {
  const first = initializeCallSocket({});
  const second = initializeCallSocket({});
  first.history.push({ role: "user", content: "private call state" });
  first.pinDigits = "12";
  assert.deepEqual(second.history, []);
  assert.equal(second.pinDigits, "");
  assert.equal(second.finalOutcome, "disconnected");
});

test("a signed WebSocket session survives a ConversationRelay error frame", async (t) => {
  if (process.env.RORC_RUN_SOCKET_TEST !== "1") {
    t.skip("set RORC_RUN_SOCKET_TEST=1 where loopback listeners are permitted");
    return;
  }
  const previousToken = process.env.TWILIO_AUTH_TOKEN;
  process.env.TWILIO_AUTH_TOKEN = "protocol-test-token";
  const server = require("../api/receptionist/conversation");
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    if (previousToken === undefined) delete process.env.TWILIO_AUTH_TOKEN;
    else process.env.TWILIO_AUTH_TOKEN = previousToken;
    if (error?.code === "EPERM") {
      t.skip("local sandbox does not permit loopback listeners; CI runs this protocol test");
      return;
    }
    throw error;
  }
  const address = server.address();
  assert.equal(typeof address, "object");
  const host = `127.0.0.1:${address.port}`;
  const signature = twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN, `wss://${host}/`, {});
  const client = new WebSocket(`ws://${host}/`, { headers: { "x-twilio-signature": signature } });
  t.after(async () => {
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.terminate();
    await new Promise((resolve) => server.close(resolve));
    if (previousToken === undefined) delete process.env.TWILIO_AUTH_TOKEN;
    else process.env.TWILIO_AUTH_TOKEN = previousToken;
  });
  await new Promise((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  const reply = new Promise((resolve, reject) => {
    client.once("message", (payload) => resolve(JSON.parse(payload.toString())));
    client.once("error", reject);
  });
  client.send(JSON.stringify({ type: "error", description: "temporary provider reset" }));
  assert.deepEqual(await reply, {
    type: "text",
    token: "The call connection had a brief problem, but I am still here. Please repeat your last request.",
    last: true,
    interruptible: true,
    preemptible: true,
  });
});
