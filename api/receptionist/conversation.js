const http = require("http");
const express = require("express");
const twilio = require("twilio");
const { WebSocketServer, WebSocket } = require("ws");
const { toSpeechText } = require("../_receptionist");
const { getCallerAccount, verifyAccountPin, accountOverview } = require("../_rorc-account-phone");
const { consent, hasConsent, sendSms } = require("../_rorc-sms");
const siteKnowledge = require("../rorc-site-knowledge.json");

const RULES = [
  "You are the warm AI receptionist for the Ruth Obenchain Recreation Center, commonly called RORC, in Bly, Oregon.",
  "Use the supplied RORC website context as the source of truth and answer as capably as someone navigating the public website for the caller.",
  "Give a direct, useful answer before suggesting a page. Explain steps, requirements, prices, policies, hours, events, rentals, memberships, projects, sponsorships, and other public information when the context supports them.",
  "Keep ordinary answers to three to six clear spoken sentences, but use more when needed to answer accurately. Never use markdown, bullets, raw URLs, or symbols. Say the website as Ruth Obenchain R C dot com.",
  "Do not invent prices, hours, availability, reservations, policies, or account details. Do not request passwords, payment-card details, or other sensitive information.",
  "Do not mention or offer Quentin unless the caller asks for him or another person, or the supplied information is genuinely insufficient for a request requiring personal help.",
  "Private account information is handled separately after caller recognition and keypad PIN verification.",
].join(" ");

const STOP_WORDS = new Set("a an and are as at be by can do for from had has have how i if in is it me my of on or our that the their they this to was we what when where which who why will with you your".split(" "));
const SMS_ROUTES = [
  { url: "https://www.ruthobenchainrc.com/membership-signup/", pattern: /\b(sign ?up|join|enroll|registration)\b/i },
  { url: "https://www.ruthobenchainrc.com/memberships/", pattern: /\b(member|membership|weight room|open gym|full facility|day pass)\b/i },
  { url: "https://www.ruthobenchainrc.com/rentals/", pattern: /\b(rent|rental|reservation|book|booking|party|wedding)\b/i },
  { url: "https://www.ruthobenchainrc.com/events/", pattern: /\b(event|calendar|schedule|what'?s happening)\b/i },
  { url: "https://www.ruthobenchainrc.com/sponsors/", pattern: /\b(sponsor|sponsorship|banner)\b/i },
  { url: "https://www.ruthobenchainrc.com/work-exchange/", pattern: /\b(work exchange|volunteer)\b/i },
  { url: "https://www.ruthobenchainrc.com/projects/", pattern: /\b(project|renovation|improvement)\b/i },
  { url: "https://www.ruthobenchainrc.com/windows/", pattern: /\b(window|windows|history tile)\b/i },
  { url: "https://www.ruthobenchainrc.com/about-rorc/", pattern: /\b(about|history|story|who runs)\b/i },
  { url: "https://www.ruthobenchainrc.com/support/", pattern: /\b(contact|support|phone|email|help desk)\b/i },
  { url: "https://www.ruthobenchainrc.com/privacy-policy/", pattern: /\bprivacy|personal data|information collected\b/i },
  { url: "https://www.ruthobenchainrc.com/terms-of-service/", pattern: /\bterms|refund|cancell?ation|rules|policy\b/i },
];

function searchTerms(value) {
  return [...new Set(String(value || "").toLowerCase().match(/[a-z0-9']{2,}/g) || [])].filter((word) => !STOP_WORDS.has(word));
}

function websiteContext(question) {
  const terms = searchTerms(question);
  const text = String(question || "").toLowerCase();
  const boostedRoutes = new Set();
  if (/\b(member|membership|join|plan|price|cost|open gym|weight room|full facility)\b/.test(text)) boostedRoutes.add("/memberships/");
  if (/\b(rent|rental|book|booking|reservation|party|wedding|deposit|cleaning|maintenance)\b/.test(text)) boostedRoutes.add("/rentals/");
  if (/\b(event|calendar|schedule|today|tomorrow|this week)\b/.test(text)) boostedRoutes.add("/events/");
  if (/\b(sponsor|banner|donat|support rorc)\b/.test(text)) boostedRoutes.add("/sponsors/");
  if (/\b(work exchange|volunteer)\b/.test(text)) boostedRoutes.add("/work-exchange/");
  if (/\b(window|windows|history tile)\b/.test(text)) boostedRoutes.add("/windows/");
  if (/\b(project|renovation|improvement)\b/.test(text)) boostedRoutes.add("/projects/");
  if (/\b(history|story|about rorc|who runs)\b/.test(text)) boostedRoutes.add("/about-rorc/");
  if (/\b(contact|phone|email|support)\b/.test(text)) boostedRoutes.add("/support/");
  if (/\b(privacy|data|information collect)\b/.test(text)) boostedRoutes.add("/privacy-policy/");
  if (/\b(term|policy|rules|refund|cancel)\b/.test(text)) boostedRoutes.add("/terms-of-service/");
  const ranked = siteKnowledge.pages.map((page) => {
    const haystack = `${page.title} ${page.route} ${page.text}`.toLowerCase();
    const termScore = terms.reduce((total, term) => total + (haystack.includes(term) ? (page.title.toLowerCase().includes(term) ? 5 : 2) : 0), 0);
    const score = termScore + (boostedRoutes.has(page.route) ? 20 : 0);
    return { page, score };
  }).sort((a, b) => b.score - a.score || a.page.index - b.page.index);
  const selected = ranked.filter((item) => item.score > 0).slice(0, 7);
  const fallback = selected.length ? selected : ranked.slice(0, 3);
  return fallback.map(({ page }) => `Page ${page.title} (${page.route}): ${page.text}`).join("\n\n").slice(0, 18000);
}

async function liveWebsiteContext(question) {
  const text = String(question || "");
  const wantsEvents = /\b(event|calendar|schedule|today|tomorrow|this week|rental availability|available date)\b/i.test(text);
  const wantsStatus = /\b(open|closed|hours|busy|activity|temperature|right now|currently)\b/i.test(text);
  const requests = [];
  if (wantsEvents) requests.push(fetch("https://www.ruthobenchainrc.com/api/events", { signal: AbortSignal.timeout(3500) }).then((response) => response.ok ? response.json() : null).catch(() => null));
  if (wantsStatus) requests.push(fetch("https://www.ruthobenchainrc.com/api/facility-activity", { signal: AbortSignal.timeout(3500) }).then((response) => response.ok ? response.json() : null).catch(() => null));
  if (!requests.length) return "";
  const results = (await Promise.all(requests)).filter(Boolean);
  return results.length ? `LIVE RORC WEBSITE DATA: ${JSON.stringify(results).slice(0, 12000)}` : "";
}

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
  return /\b(talk|speak|connect|transfer|forward|put me through|reach)\b.{0,80}\b(quentin|person|human|staff|team|someone|representative|receptionist)\b|\b(quentin|person|human|staff|team|someone|representative|receptionist)\b.{0,80}\b(talk|speak|connect|transfer|forward|reach)\b|\b(is|are)\s+(quentin|someone|staff)\s+(there|available)\b/i.test(String(value || ""));
}

function hasTransferReason(value) {
  const text = String(value || "").trim();
  return text.split(/\s+/).length >= 6 && /\b(membership|billing|rental|event|sponsor|project|account|issue|problem|facility|gym|access|payment|support|website|policy|reservation|personal matter)\b/i.test(text);
}

function replyNeedsHuman(value) {
  return /\b(i (?:do not|don't) (?:have|know)|i cannot confirm|not listed in the (?:site|website|information)|contact the rorc team|requires personal assistance)\b/i.test(String(value || ""));
}

function isAccountRequest(value) {
  return /\b(my|our)\b.{0,40}\b(account|membership|billing|balance|expiration|status|access|dues)\b|\b(account|membership|billing|balance|expiration|status|access|dues)\b.{0,40}\b(my|our)\b/i.test(String(value || ""));
}

function isSmsRequest(value) {
  const text = String(value || "");
  return /\b(text|sms|message)\b.{0,100}\b(me|my|that|it|link|page|website|information|info|details|answer|summary|recap|directions)\b/i.test(text)
    || /\b(send|share|forward)\b.{0,100}\b(me|my phone|that|it|the link|a link|this|page|website|information|info|details|answer|summary|directions)\b/i.test(text)
    || /\b(send|share|forward)\b.{0,100}\b(link|page|website|information|info|details|directions)\b/i.test(text);
}

function smsDestination(question, history = []) {
  const current = String(question || "");
  const recent = history.slice(-6).map((item) => String(item?.content || "")).join(" ");
  return SMS_ROUTES.find(({ pattern }) => pattern.test(current))?.url
    || SMS_ROUTES.find(({ pattern }) => pattern.test(recent))?.url
    || "https://www.ruthobenchainrc.com/";
}

function priorAnswer(history = []) {
  return [...history].reverse().find((item) => item?.role === "assistant" && item.content)?.content || "";
}

function isReferentialSmsRequest(question) {
  const text = String(question || "");
  return /\b(send|share|forward|text|message)\b.{0,80}\b(that|it|this|the link|that link|this link)\b/i.test(text)
    && !SMS_ROUTES.some(({ pattern }) => pattern.test(text));
}

async function answer(question, history) {
  const key = String(process.env.GROQ_API_KEY || "").trim();
  if (!key) return "I can help with general RORC information, but the conversational service is still being configured. Please visit Ruth Obenchain R C dot com or call the RORC team directly.";
  const [siteContext, liveContext] = await Promise.all([Promise.resolve(websiteContext(question)), liveWebsiteContext(question)]);
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: String(process.env.GROQ_RECEPTIONIST_MODEL || "openai/gpt-oss-120b"), temperature: 0.15, max_tokens: 650, messages: [{ role: "system", content: `${RULES}\n\nCURRENT PUBLIC RORC WEBSITE CONTEXT:\n${siteContext}${liveContext ? `\n\n${liveContext}` : ""}` }, ...history.slice(-8), { role: "user", content: question }] }),
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
  const link = smsDestination(question, ws.history);
  const previous = priorAnswer(ws.history);
  const reply = isReferentialSmsRequest(question) && previous
    ? previous
    : await answer(question, ws.history);
  const summary = String(reply || "Here is the RORC information you requested.")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 850);
  const body = `RORC: ${summary}\n\n${link}\n\nReply STOP to opt out or HELP for help.`;
  await sendSms(ws.fromNumber, body);
  speech(ws, "Done. I texted the information and the most relevant RORC page to the number you are calling from.");
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
  ws.awaitingTransferReason = false;
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
    if (ws.awaitingTransferReason) {
      ws.awaitingTransferReason = false;
      ws.processing = true;
      try {
        const reply = await answer(question, ws.history);
        ws.history.push({ role: "user", content: question }, { role: "assistant", content: reply });
        ws.history = ws.history.slice(-10);
        ws.transferOffered = true;
        ws.transferSummary = `The caller asked for Quentin regarding: ${question.slice(0, 160)}`;
        speech(ws, `${reply} Would you still like me to connect you with Quentin?`);
      } catch (error) {
        console.error("RORC transfer screening failed", error);
        speech(ws, "Thank you. Would you like me to connect you with Quentin now?");
        ws.transferOffered = true;
      } finally { ws.processing = false; }
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
    if (isPersonRequest(question) && !hasTransferReason(question)) {
      ws.awaitingTransferReason = true;
      speech(ws, "I can help with most RORC questions here. What is the call regarding so I can either help you directly or prepare the right handoff?");
      return;
    }
    ws.processing = true;
    try {
      const reply = await answer(question, ws.history);
      ws.history.push({ role: "user", content: question }, { role: "assistant", content: reply });
      ws.history = ws.history.slice(-10);
      if (isPersonRequest(question)) {
        ws.transferOffered = true;
        ws.transferSummary = `The caller asked for Quentin regarding: ${question.slice(0, 160)}`;
        speech(ws, `${reply} Would you like me to connect you with Quentin now?`);
      } else if (replyNeedsHuman(reply)) {
        ws.transferOffered = true;
        ws.transferSummary = `The website receptionist could not fully resolve: ${question.slice(0, 160)}`;
        speech(ws, `${reply} If you need personal help with that, I can try connecting you with Quentin. Would you like me to do that?`);
      } else speech(ws, reply);
    } catch (error) {
      console.error("RORC receptionist response failed", error);
      speech(ws, "I'm sorry, I had trouble answering that. Please try your question again.");
    } finally { ws.processing = false; }
  });
});

module.exports = server;
module.exports.websiteContext = websiteContext;
module.exports.isPersonRequest = isPersonRequest;
module.exports.hasTransferReason = hasTransferReason;
module.exports.replyNeedsHuman = replyNeedsHuman;
module.exports.isSmsRequest = isSmsRequest;
module.exports.smsDestination = smsDestination;
module.exports.isReferentialSmsRequest = isReferentialSmsRequest;
