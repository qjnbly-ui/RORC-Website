const assert = require("node:assert/strict");
const twilio = require("twilio");
const { WebSocket } = require("ws");

const baseUrl = String(process.env.RORC_SMOKE_BASE_URL || "").replace(/\/+$/, "");
const authToken = String(process.env.TWILIO_AUTH_TOKEN || "").trim();

if (!baseUrl) throw new Error("Set RORC_SMOKE_BASE_URL to the Vercel preview or staging URL.");

async function jsonEndpoint(path) {
  const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(10000) });
  assert.equal(response.ok, true, `${path} returned HTTP ${response.status}`);
  return response.json();
}

function nextMessage(socket, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ConversationRelay response timed out.")), timeoutMs);
    socket.once("message", (payload) => {
      clearTimeout(timer);
      try { resolve(JSON.parse(payload.toString())); } catch (error) { reject(error); }
    });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

async function ask(socket, question) {
  const reply = nextMessage(socket);
  socket.send(JSON.stringify({ type: "prompt", voicePrompt: question, last: true }));
  const message = await reply;
  assert.equal(message.type, "text", `Expected a text response to: ${question}`);
  const answer = String(message.token || "").trim();
  assert.ok(answer, `Received an empty answer to: ${question}`);
  assert.doesNotMatch(answer, /(?:i(?:'m| am) sorry|can(?:not|'t) do that|trouble answering|try again later)/i);
  return answer;
}

async function websocketSmoke() {
  if (!authToken) {
    console.log("WebSocket smoke skipped: TWILIO_AUTH_TOKEN is not set.");
    return;
  }
  const relayUrl = new URL("/api/receptionist/conversation", baseUrl);
  relayUrl.protocol = relayUrl.protocol === "https:" ? "wss:" : "ws:";
  const signatureUrl = new URL(relayUrl);
  signatureUrl.protocol = "wss:";
  const signature = twilio.getExpectedTwilioSignature(authToken, signatureUrl.toString(), {});
  const socket = new WebSocket(relayUrl, { headers: { "x-twilio-signature": signature } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ConversationRelay connection timed out.")), 10000);
    socket.once("open", () => { clearTimeout(timer); resolve(); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  try {
    const temperature = await ask(socket, "What is the current temperature in the gym?");
    assert.match(temperature, /temperature|degrees/i);
    const busiest = await ask(socket, "What is usually the busiest time of the day at the gym?");
    assert.match(busiest, /busiest|check-ins|recorded period/i);
    console.log(`Temperature answer: ${temperature}`);
    console.log(`Busiest-time answer: ${busiest}`);
  } finally {
    socket.close();
  }
}

async function main() {
  const facility = await jsonEndpoint("/api/facility-activity");
  assert.equal(facility.success, true, "Facility endpoint did not report success.");
  assert.ok(facility.activity && typeof facility.activity === "object", "Facility endpoint did not include activity data.");
  await jsonEndpoint("/api/events");
  console.log("HTTP live-data checks passed.");
  await websocketSmoke();
  console.log("Receptionist staging smoke passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
