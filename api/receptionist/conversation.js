const http = require("http");
const express = require("express");
const twilio = require("twilio");
const { WebSocketServer, WebSocket } = require("ws");
const { toSpeechText } = require("../_receptionist");
const { getCallerAccount, verifyAccountPin, accountOverview } = require("../_rorc-account-phone");
const { consent, hasConsent, sendSms } = require("../_rorc-sms");

const RULES = [
  "You are the warm AI receptionist for the Ruth Obenchain Recreation Center, commonly called RORC, in Bly, Oregon.",
  "Answer only from this current knowledge: RORC is a community recreation center at 19140 Edler Street in Bly; it offers memberships, gym and open-gym access, community events, rentals, and member support. Facility hours and event availability can change, so direct callers to ruthobenchainrc.com or the RORC team when you are unsure.",
  "Keep answers to three or four short spoken sentences. Never use markdown, bullets, raw URLs, or symbols. Say the website as Ruth Obenchain R C dot com.",
  "Do not invent prices, hours, availability, reservations, policies, or account details. Do not request passwords, payment-card details, or other sensitive information.",
  "If the caller asks for a person, first ask what the call is about. Once they give a legitimate RORC-related reason, offer a live transfer and wait for a clear yes before transferring.",
].join(" ");

function wsUrl(req) {
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "ruthobenchainrc.com").split(",")[0].trim();
  return `wss://${host}${req.url}`;
}

function validClient(info, done) {
  const token = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
  const signature = String(info.req.headers["x-twilio-signature"] || "").trim();
  if (!token || !signature) return done(false, 403, "Invalid Twilio signature");
  const valid = twilio.validateRequest(token, signature, wsUrl(info.req), {});
  return done(valid, valid ? 101 : 403, valid ? undefined : "Invalid Twilio signature");
}

function speech(ws, text) {
  const clean = toSpeechText(text);
  if (ws.readyState !== WebSocket.OPEN || !clean) return;
  ws.send(JSON.stringify({ type: "text", token: clean, last: true, interruptible: true, preemptible: true }));
  ws.activeSpeech = clean;
}

function isYes(value) {
  return /^(yes|yeah|yep|sure|okay|ok|please|go ahead|connect me|transfer me|sounds good)[.!? ]*$/i.test(String(value || "").trim());
}

function isPersonRequest(value) {
  return /\b(talk|speak|connect|transfer|forward|put me through|reach)\b.{0,60}\b(person|human|staff|team|someone|representative|receptionist)\b|\b(person|human|staff|team|someone|representative|receptionist)\b.{0,60}\b(talk|speak|connect|transfer|reach)\b/i.test(String(value || ""));
}

function isAccountRequest(value) {
  return /\b(my|our)\b.{0,40}\b(account|membership|billing|balance|expiration|status|access|dues)\b|\b(account|membership|billing|balance|expiration|status|access|dues)\b.{0,40}\b(my|our)\b/i.test(String(value || ""));
}

function isSmsRequest(value) {
  return /\b(text|sms|message)\b/i.test(String(value || "")) && /\b(me|my|that|it|link|information|details|answer|summary|recap)\b/i.test(String(value || ""));
}

async function answer(question, history) {
  const key = String(process.env.GROQ_API_KEY || "").trim();
  if (!key) return "I can help with general RORC information, but the conversational service is still being configured. Please visit Ruth Obenchain R C dot com or call the RORC team directly.";
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: String(process.env.GROQ_RECEPTIONIST_MODEL || "openai/gpt-oss-120b"), temperature: 0.2, max_tokens: 360, messages: [{ role: "system", content: RULES }, ...history.slice(-8), { role: "user", content: question }] }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || "AI response failed");
  return toSpeechText(data?.choices?.[0]?.message?.content) || "I'm sorry, I couldn't answer that right now. Please try again or contact the RORC team.";
}

async function sendRequestedSms(ws, question) {
  if (!ws.fromNumber || !(await hasConsent(ws.fromNumber))) {
    ws.awaitingSmsConsent = true;
    ws.pendingSmsQuestion = question;
    speech(ws, "I can text the requested RORC information to the number you are calling from. Message and data rates may apply, and message frequency varies. Would you like me to send it? You can say stop at any time to opt out.");
    return;
  }
  const reply = await answer(question, ws.history);
  const body = `RORC: ${reply} Visit https://ruthobenchainrc.com for more information. Reply STOP to opt out or HELP for help.`;
  await sendSms(ws.fromNumber, body);
  speech(ws, "Done. I sent the requested RORC information to the number you are calling from.");
}

const app = express();
app.use((_req, res) => res.status(426).json({ error: "WebSocket upgrade required." }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024, perMessageDeflate: false, verifyClient: validClient });

wss.on("connection", (ws) => {
  ws.history = [];
  ws.processing = false;
  ws.transferOffered = false;
  ws.activeSpeech = "";
  ws.caller = null;
  ws.callerReady = Promise.resolve(null);
  ws.awaitingPin = false;
  ws.pinDigits = "";
  ws.accountVerified = false;
  ws.pinAttempts = 0;
  ws.awaitingSmsConsent = false;
  ws.pendingSmsQuestion = "";
  ws.on("message", async (raw) => {
    let message;
    try { message = JSON.parse(raw.toString("utf8")); } catch { return; }
    if (message.type === "setup") {
      const expectedAccount = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
      if (expectedAccount && message.accountSid !== expectedAccount) {
        ws.close(1008, "Twilio account mismatch");
        return;
      }
      ws.callSid = String(message.callSid || "");
      ws.fromNumber = String(message.from || "");
      ws.callerReady = getCallerAccount(ws.fromNumber).then((caller) => { ws.caller = caller; return caller; }).catch(() => null);
      return;
    }
    if (message.type === "interrupt") { ws.activeSpeech = ""; return; }
    if (message.type === "dtmf" && ws.awaitingPin) {
      const digit = String(message.digit || "");
      if (!/^\d$/.test(digit)) return;
      ws.pinDigits = `${ws.pinDigits}${digit}`.slice(0, 4);
      if (ws.pinDigits.length < 4 || ws.processing) return;
      ws.processing = true;
      ws.pinAttempts += 1;
      try {
        if (verifyAccountPin(ws.caller, ws.pinDigits)) {
          ws.awaitingPin = false;
          ws.accountVerified = true;
          speech(ws, accountOverview(ws.caller));
        } else if (ws.pinAttempts >= 3) {
          ws.awaitingPin = false;
          speech(ws, "That PIN did not match. For your security, please use the RORC website or contact the RORC team for account help.");
        } else {
          ws.pinDigits = "";
          speech(ws, "That PIN did not match. Please enter the four digits again using your keypad.");
        }
      } finally { ws.pinDigits = ""; ws.processing = false; }
      return;
    }
    if (message.type !== "prompt" || message.last === false || ws.processing) return;
    const question = toSpeechText(message.voicePrompt).slice(0, 800);
    if (!question) return;
    if (ws.awaitingSmsConsent) {
      if (isYes(question)) {
        ws.awaitingSmsConsent = false;
        const pendingQuestion = ws.pendingSmsQuestion;
        ws.pendingSmsQuestion = "";
        try {
          await consent(ws.fromNumber, "opt_in", "voice_call");
          await sendRequestedSms(ws, pendingQuestion);
        } catch (error) {
          console.error("RORC verbal SMS consent failed", error);
          speech(ws, "I could not send that text right now. Please try again later.");
        }
      } else if (/^(no|nope|not now|don't|do not)[.!? ]*$/i.test(question)) {
        ws.awaitingSmsConsent = false;
        ws.pendingSmsQuestion = "";
        speech(ws, "No problem. I will not send a text.");
      } else speech(ws, "Please say yes if you would like the requested information by text, or no if you do not.");
      return;
    }
    if (isAccountRequest(question)) {
      await ws.callerReady;
      if (!ws.caller || ws.caller.ambiguous) {
        speech(ws, "I could not securely match this number to one RORC account. Please contact the RORC team for account assistance.");
      } else if (ws.accountVerified) {
        speech(ws, accountOverview(ws.caller));
      } else {
        ws.awaitingPin = true;
        ws.pinDigits = "";
        speech(ws, "For security, please enter the four digit account PIN using your keypad. I will not ask you to say it aloud.");
      }
      return;
    }
    if (isSmsRequest(question)) {
      ws.processing = true;
      try { await sendRequestedSms(ws, question); }
      catch (error) { console.error("RORC receptionist SMS failed", error); speech(ws, "I could not send that text right now. Please visit Ruth Obenchain R C dot com or try again later."); }
      finally { ws.processing = false; }
      return;
    }
    if (ws.transferOffered) {
      if (isYes(question)) {
        ws.transferOffered = false;
        ws.send(JSON.stringify({ type: "end", handoffData: JSON.stringify({ reasonCode: "approved-rorc-transfer", summary: ws.transferSummary || "The caller requested RORC staff assistance." }) }));
        return;
      }
      ws.transferOffered = false;
      speech(ws, "No problem. What else can I help you with?");
      return;
    }
    ws.processing = true;
    try {
      const reply = await answer(question, ws.history);
      ws.history.push({ role: "user", content: question }, { role: "assistant", content: reply });
      ws.transferOffered = true;
      ws.transferSummary = `The caller wants RORC assistance regarding: ${question.slice(0, 140)}`;
      const offer = isPersonRequest(question) || /\b(speak|talk|connect|transfer)\b/i.test(question)
        ? "Would you like me to connect you with Quentin now?"
        : "If you would rather speak with Quentin, I can connect you with him. Would you like me to do that now?";
      speech(ws, `${reply} ${offer}`);
    } catch (error) {
      console.error("RORC receptionist response failed", error);
      speech(ws, "I'm sorry, I had trouble answering that. Please try your question again.");
    } finally { ws.processing = false; }
  });
});

module.exports = server;
