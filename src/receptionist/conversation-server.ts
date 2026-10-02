const http = require("http");
const express = require("express");
const twilio = require("twilio");
const { WebSocketServer, WebSocket } = require("ws");
const { toSpeechText } = require("../../api/_receptionist");
const { getCallerAccount, verifyAccountPin, accountOverview } = require("../../api/_rorc-account-phone");
const { normalizePhone, consent, hasConsent, sendSms } = require("../../api/_rorc-sms");
const { createFormDraft } = require("../../api/_rorc-form-drafts");
const { getFormDefinition, detectFormRequest } = require("../../api/_rorc-forms");
const { classifyIntent, fallbackIntent, safeIntentResult } = require("./router");

const {
  pinStatus,
  recordEvent,
  recordPinAttempt,
  recordReviewItem,
  startCall,
  updateCall,
} = require("../../api/_receptionist-analytics");
import type { Request, Response } from "express";
import type { IncomingMessage } from "http";
import type { WebSocket as WebSocketType } from "ws";
import type { DetailLevel, FormSession, HistoryItem, IntentResult } from "./contracts";
import {
  isDirectFormChoice,
  isFinishForm,
  isGuidedFormChoice,
  isYes,
  normalizeFormAnswer,
  spokenDate,
  spokenEmail,
  spokenNumber,
  spokenPhone,
  spokenTime,
} from "./form-input";
import { parseRelayMessage, sendApprovedHandoff, sendRelayText } from "./protocol";
import { initializeCallSocket, type CallSocket as ReceptionistSocket } from "./state";
import { deterministicLiveAnswer, usefulProviderFallback } from "./live-answers";
import { KNOWLEDGE_VERSION, PROMPT_VERSION, ROUTER_MODEL, ANSWER_MODEL_VERSION, SMS_ROUTES, websiteContext, liveWebsiteContext, wantsDetailedAnswer, responseLimits, trimAnswerForQuestion, answer, smsDestination, smsMessageFor } from "./public-assistant";
function wsUrl(req: IncomingMessage): string {
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "ruthobenchainrc.com").split(",")[0]?.trim() || "ruthobenchainrc.com";
  return `wss://${host}${req.url}`;
}

function validClient(info: any, done: (result: boolean, code?: number, message?: string) => void): void {
  const token = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
  const signature = String(info.req.headers["x-twilio-signature"] || "").trim();
  if (!token || !signature) return done(false, 403, "Invalid Twilio signature");
  const valid = twilio.validateRequest(token, signature, wsUrl(info.req), {});
  return done(valid, valid ? 101 : 403, valid ? undefined : "Invalid Twilio signature");
}

function speech(ws: ReceptionistSocket, text: unknown): void {
  const clean = toSpeechText(text);
  if (ws.readyState !== WebSocket.OPEN || !clean) return;
  sendRelayText(ws, clean);
  ws.activeSpeech = clean;
}

function isPersonRequest(value: unknown): boolean {
  return /\b(talk|speak|connect|transfer|forward|put me through|reach)\b.{0,80}\b(quentin|person|human|staff|team|someone|representative|receptionist)\b|\b(quentin|person|human|staff|team|someone|representative|receptionist)\b.{0,80}\b(talk|speak|connect|transfer|forward|reach)\b|\b(is|are)\s+(quentin|someone|staff)\s+(there|available)\b/i.test(String(value || ""));
}

function hasTransferReason(value: unknown): boolean {
  const text = String(value || "").trim();
  return text.split(/\s+/).length >= 6 && /\b(membership|billing|rental|event|sponsor|project|account|issue|problem|facility|gym|access|payment|support|website|policy|reservation|personal matter)\b/i.test(text);
}

function replyNeedsHuman(value: unknown): boolean {
  return /\b(i (?:do not|don't) (?:have|know)|i cannot confirm|not listed in the (?:site|website|information)|contact the rorc team|requires personal assistance)\b/i.test(String(value || ""));
}

function isAccountRequest(value: unknown): boolean {
  return /\b(my|our)\b.{0,40}\b(account|membership|billing|balance|expiration|status|access|dues)\b|\b(account|membership|billing|balance|expiration|status|access|dues)\b.{0,40}\b(my|our)\b/i.test(String(value || ""));
}

function isSmsRequest(value: unknown): boolean {
  const text = String(value || "");
  return /\b(text|sms|message)\b.{0,100}\b(me|my|that|it|link|page|website|information|info|details|answer|summary|recap|directions)\b/i.test(text)
    || /\b(send|share|forward)\b.{0,100}\b(me|my phone|that|it|the link|a link|this|page|website|information|info|details|answer|summary|directions)\b/i.test(text)
    || /\b(send|share|forward)\b.{0,100}\b(link|page|website|information|info|details|directions)\b/i.test(text);
}

function priorAnswer(history: HistoryItem[] = []): string {
  return [...history].reverse().find((item) => item?.role === "assistant" && item.content)?.content || "";
}

function repeatConversationReply(question: string, history: HistoryItem[] = []): string {
  const text = String(question || "").replace(/[.!?]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  const asksToRepeat = /^(?:please )?(?:repeat|repeat that|say that again|could you repeat(?: that)?|can you repeat(?: that)?|what did you say)(?: (?:please|you were cutting out|i (?:did not|didn't|could not|couldn't) (?:hear|catch)(?: that)?))?$/.test(text)
    || /\b(?:repeat|say that again)\b.*\b(?:cutting out|did not hear|didn't hear|could not hear|couldn't hear|did not catch|didn't catch)\b/.test(text);
  if (!asksToRepeat) return "";
  const previous = priorAnswer(history);
  return previous || "I’m sorry—I do not have a previous answer to repeat. Please ask the question again.";
}

function isReferentialSmsRequest(question: string): boolean {
  const text = String(question || "");
  return /\b(send|share|forward|text|message)\b.{0,80}\b(that|it|this|the link|that link|this link)\b/i.test(text)
    && !SMS_ROUTES.some(({ pattern }) => pattern.test(text));
}

function publicBaseUrl(): string {
  return String(process.env.RORC_PUBLIC_BASE_URL || "https://www.ruthobenchainrc.com").replace(/\/+$/, "");
}

async function track(ws: ReceptionistSocket, event: Record<string, unknown>): Promise<unknown> {
  try {
    await ws.analyticsReady;
    if (!ws.callerKey) return null;
    return await recordEvent(ws.callSid, event);
  } catch (error) {
    console.error("RORC receptionist analytics failed", error);
    return null;
  }
}

function reviewReasons(route: Partial<IntentResult> = {}, unresolved = false): string[] {
  const reasons = [];
  if (route.source === "fallback") reasons.push("router_fallback");
  if (Number.isFinite(route.confidence) && Number(route.confidence) < 0.65) reasons.push("low_confidence");
  if (route.needsClarification) reasons.push("needs_clarification");
  if (unresolved) reasons.push("unresolved_answer");
  return [...new Set(reasons)];
}

async function queueReview(
  ws: ReceptionistSocket,
  question: string,
  response: string,
  route: Partial<IntentResult> = {},
  reasons: string[] = reviewReasons(route),
): Promise<unknown> {
  if (!reasons.length) return null;
  try {
    await ws.analyticsReady;
    if (!ws.callerKey) return null;
    return await recordReviewItem(ws.callSid, {
      utterance: question,
      response,
      reasons,
      intent: route.intent,
      confidence: route.confidence,
      routeSource: route.source,
      knowledgeVersion: KNOWLEDGE_VERSION,
      promptVersion: PROMPT_VERSION,
      routerModel: ROUTER_MODEL,
      answerModel: ANSWER_MODEL_VERSION,
    });
  } catch (error) {
    console.error("RORC receptionist review queue failed", error);
    return null;
  }
}

async function recordRequestedSmsConsent(ws: ReceptionistSocket): Promise<void> {
  if (!ws.fromNumber) throw new Error("The caller phone number is unavailable.");
  if (!(await hasConsent(ws.fromNumber))) await consent(ws.fromNumber, "opt_in", "voice_request");
}

async function sendRequestedSms(ws: ReceptionistSocket, question: string): Promise<void> {
  await recordRequestedSmsConsent(ws);
  const message = smsMessageFor(question, ws.history);
  const result = await sendSms(ws.fromNumber, message.body, { statusCallback: `${publicBaseUrl()}/api/receptionist/sms-status` });
  await track(ws, { type: "sms_sent", messageSid: result?.sid, metadata: { kind: "information", destination: smsDestination(question, ws.history), initialStatus: result?.status || "accepted" } });
  ws.finalOutcome = "sms_sent";
  speech(ws, `Done. I texted ${message.confirmation} to the number you are calling from.`);
}

async function sendFormLink(ws: ReceptionistSocket, formId: string): Promise<void> {
  const form = getFormDefinition(formId);
  if (!form) throw new Error("Unknown RORC form.");
  await recordRequestedSmsConsent(ws);
  const result = await sendSms(ws.fromNumber, `RORC ${form.title}: ${form.url}\n\nComplete and submit the form securely online. Reply STOP to opt out or HELP for help.`, { statusCallback: `${publicBaseUrl()}/api/receptionist/sms-status` });
  await track(ws, { type: "form_link_sent", messageSid: result?.sid, metadata: { formId, initialStatus: result?.status || "accepted" } });
  ws.finalOutcome = "form_link_sent";
  speech(ws, `Done. I texted you the ${form.title} link.`);
}

async function sendFormDraft(ws: ReceptionistSocket, formId: string, answers: Record<string, string | number>): Promise<void> {
  const form = getFormDefinition(formId);
  if (!form) throw new Error("Unknown RORC form.");
  await recordRequestedSmsConsent(ws);
  const draft = await createFormDraft(formId, answers, ws.fromNumber);
  const result = await sendSms(ws.fromNumber, `RORC ${form.title} draft: ${draft.url}\n\nReview the prefilled information, complete the remaining required sections, and submit it within 7 days. Reply STOP to opt out or HELP for help.`, { statusCallback: `${publicBaseUrl()}/api/receptionist/sms-status` });
  await track(ws, { type: "form_draft_sent", messageSid: result?.sid, metadata: { formId, initialStatus: result?.status || "accepted" } });
  ws.finalOutcome = "form_draft_sent";
  speech(ws, `Done. I texted your prefilled ${form.title}. Please review it and finish the required sections online within seven days.`);
}

function beginFormSession(ws: ReceptionistSocket, formId: string): boolean {
  const form = getFormDefinition(formId);
  if (!form) return false;
  ws.formOffer = "";
  ws.formSession = { formId, fieldIndex: 0, answers: {} };
  ws.finalOutcome = "form_started";
  track(ws, { type: "form_started", metadata: { formId, mode: "guided" } });
  speech(ws, `Great. I will collect the safe basics and leave passwords, PINs, signatures, agreements, uploads, and payment completion for the secure website. You can say skip, finish online, or cancel at any time. ${form.fields[0].prompt}`);
  return true;
}

async function finishFormSession(ws: ReceptionistSocket): Promise<void> {
  const session = ws.formSession;
  if (!session) return;
  ws.formSession = null;
  if (!Object.keys(session.answers).length) return sendFormLink(ws, session.formId);
  return sendFormDraft(ws, session.formId, session.answers);
}

async function handleFormAnswer(ws: ReceptionistSocket, question: string): Promise<boolean> {
  const session = ws.formSession;
  const form = getFormDefinition(session?.formId);
  if (!session || !form) return false;
  if (/^(cancel|never mind|nevermind|stop)[.!? ]*$/i.test(question)) {
    ws.formSession = null;
    speech(ws, "No problem. I discarded this call's form answers. What else can I help with?");
    return true;
  }
  if (isFinishForm(question)) {
    await finishFormSession(ws);
    return true;
  }
  const field = form.fields[session.fieldIndex];
  const parsed = await normalizeFormAnswer(field, question, ws.fromNumber);
  if (!parsed) {
    const extra = field.type === "email" ? " Please say it like name at example dot com." : field.type === "phone" ? " Please say the full ten digit number, or say yes to use the number you called from." : "";
    speech(ws, `I did not catch that clearly.${extra} ${field.prompt}`);
    return true;
  }
  if (!parsed.skipped) session.answers[field.key] = parsed.value;
  session.fieldIndex += 1;
  if (session.fieldIndex >= form.fields.length) {
    await finishFormSession(ws);
    return true;
  }
  speech(ws, `${parsed.skipped ? "Okay, we will leave that for the website." : "Got it."} ${form.fields[session.fieldIndex].prompt}`);
  return true;
}

function intentDetectors() {
  return {
    detectFormRequest,
    isAccountRequest,
    isSmsRequest,
    isPersonRequest,
    wantsDetailedAnswer,
    isGuidedFormChoice,
    isDirectFormChoice,
  };
}

async function routeIntent(ws: ReceptionistSocket, question: string): Promise<IntentResult> {
  const started = Date.now();
  let result;
  try {
    result = safeIntentResult(await classifyIntent(question, ws.history), question, intentDetectors());
  } catch (error) {
    result = fallbackIntent(question, intentDetectors());
    await track(ws, { type: "router_error", success: false, error, latencyMs: Date.now() - started });
  }
  await track(ws, {
    type: "intent_routed",
    intent: result.intent,
    confidence: result.confidence,
    latencyMs: Date.now() - started,
    utterance: question,
    metadata: {
      source: result.source,
      detailLevel: result.detail_level,
      formId: result.form_id,
      formAction: result.form_action,
      liveData: result.live_data,
      liveFact: result.live_fact,
      needsClarification: Boolean(result.needsClarification),
    },
  });
  return result;
}

async function answerAndRemember(ws: ReceptionistSocket, question: string, detailLevel: DetailLevel, route: Partial<IntentResult> = {}): Promise<string> {
  const started = Date.now();
  const reply = await answer(question, ws.history, detailLevel, route);
  ws.history.push({ role: "user", content: question }, { role: "assistant", content: reply });
  ws.history = ws.history.slice(-10);
  await track(ws, { type: "answer_generated", latencyMs: Date.now() - started, metadata: { detailLevel } });
  ws.finalOutcome = "answered";
  return reply;
}

async function beginAccountCheck(ws: ReceptionistSocket): Promise<void> {
  await Promise.all([ws.callerReady, ws.analyticsReady]);
  if (!ws.callerKey) {
    await track(ws, { type: "account_check", success: false, errorCode: "security_not_configured" });
    speech(ws, "Private account checks are temporarily unavailable. Please use the secure RORC website or contact the RORC team.");
    return;
  }
  if (!ws.caller || ws.caller.ambiguous) {
    await track(ws, { type: "account_check", success: false, errorCode: ws.caller?.ambiguous ? "ambiguous_caller" : "caller_not_found" });
    speech(ws, "I could not securely match this number to one RORC account. Please contact the RORC team for account assistance.");
    return;
  }
  if (ws.accountVerified) {
    speech(ws, accountOverview(ws.caller));
    return;
  }
  try {
    const status = await pinStatus(ws.callerKey);
    if (status.isLocked) {
      await track(ws, { type: "pin_locked", success: false, errorCode: "pin_locked" });
      speech(ws, "For your security, account PIN attempts are temporarily locked. Please wait thirty minutes, use the secure RORC website, or contact the RORC team.");
      return;
    }
    ws.awaitingPin = true;
    ws.pinDigits = "";
    speech(ws, "For security, please enter the four digit account PIN using your keypad. I will not ask you to say it aloud.");
  } catch (error) {
    await track(ws, { type: "pin_status_error", success: false, error });
    speech(ws, "Private account checks are temporarily unavailable. Please use the secure RORC website or contact the RORC team.");
  }
}

async function handleFormIntent(ws: ReceptionistSocket, route: IntentResult): Promise<void> {
  const formId = route.form_id !== "none" ? route.form_id : detectFormRequest(route.topic);
  const form = getFormDefinition(formId);
  if (!form) {
    speech(ws, "Which form would you like help with: membership, facility rental, or banner sponsorship?");
    return;
  }
  if (route.form_action === "guided") {
    beginFormSession(ws, formId);
    ws.finalOutcome = "form_started";
    return;
  }
  if (route.form_action === "send_link") {
    await sendFormLink(ws, formId);
    ws.finalOutcome = "form_link_sent";
    return;
  }
  ws.formOffer = formId;
  await track(ws, { type: "form_offered", metadata: { formId } });
  speech(ws, `I can text you the ${form.title} link now, or I can help fill out the basic information and then send you a secure link to review and finish. Which would you prefer?`);
}

async function handlePersonIntent(ws: ReceptionistSocket, question: string): Promise<void> {
  if (!hasTransferReason(question)) {
    ws.awaitingTransferReason = true;
    await track(ws, { type: "transfer_screening_started" });
    speech(ws, "I can help with most RORC questions here. What is the call regarding so I can either help you directly or prepare the right handoff?");
    return;
  }
  const reply = await answerAndRemember(ws, question, "normal");
  ws.transferOffered = true;
  ws.transferSummary = `The caller asked for Quentin regarding: ${question.slice(0, 160)}`;
  await track(ws, { type: "transfer_offered", metadata: { screened: true } });
  speech(ws, `${reply} Would you still like me to connect you with Quentin?`);
}

const app = express();
app.use((_req: Request, res: Response) => res.status(426).json({ error: "WebSocket upgrade required." }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024, perMessageDeflate: false, verifyClient: validClient });

wss.on("connection", (socket: WebSocketType) => {
  const ws = initializeCallSocket(socket);
  ws.on("message", async (raw) => {
    const message = parseRelayMessage(raw as Buffer);
    if (!message) return;
    if (message.type === "setup") {
      const expectedAccount = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
      if (expectedAccount && message.accountSid !== expectedAccount) {
        ws.close(1008, "Twilio account mismatch");
        return;
      }
      ws.callSid = String(message.callSid || "");
      ws.fromNumber = String(message.from || "");
      ws.callerReady = getCallerAccount(ws.fromNumber).then((caller: any) => { ws.caller = caller; return caller; }).catch(() => null);
      ws.analyticsReady = startCall({
        callSid: ws.callSid,
        phone: ws.fromNumber,
        knowledgeVersion: KNOWLEDGE_VERSION,
        promptVersion: PROMPT_VERSION,
        routerModel: ROUTER_MODEL,
        answerModel: ANSWER_MODEL_VERSION,
      })
        .then(async (key: string | null) => {
          ws.callerKey = key || "";
          const caller = await ws.callerReady;
          await updateCall(ws.callSid, { recognized: Boolean(caller && !caller.ambiguous) });
          return key;
        })
        .catch((error: unknown) => {
          console.error("RORC call analytics setup failed", error);
          return null;
        });
      return;
    }
    if (message.type === "interrupt") { ws.activeSpeech = ""; return; }
    if (message.type === "error") {
      await track(ws, { type: "conversation_relay_error", success: false, errorCode: "twilio_relay_error", metadata: { description: String(message.description || "Unknown ConversationRelay error").slice(0, 500) } });
      speech(ws, "The call connection had a brief problem, but I am still here. Please repeat your last request.");
      return;
    }
    if (message.type === "dtmf" && ws.awaitingPin) {
      const digit = String(message.digit || "");
      if (!/^\d$/.test(digit)) return;
      ws.pinDigits = `${ws.pinDigits}${digit}`.slice(0, 4);
      if (ws.pinDigits.length < 4 || ws.processing) return;
      ws.processing = true;
      try {
        const succeeded = verifyAccountPin(ws.caller, ws.pinDigits);
        const status = await recordPinAttempt(ws.callerKey, succeeded);
        if (succeeded) {
          ws.awaitingPin = false;
          ws.accountVerified = true;
          ws.finalOutcome = "account_checked";
          await updateCall(ws.callSid, { verified: true, outcome: ws.finalOutcome });
          await track(ws, { type: "pin_verified" });
          speech(ws, accountOverview(ws.caller));
        } else if (status.isLocked) {
          ws.awaitingPin = false;
          await track(ws, { type: "pin_failed", success: false, errorCode: "pin_locked", metadata: { failedAttempts: status.failedAttempts } });
          speech(ws, "That PIN did not match. For your security, account PIN attempts are locked for thirty minutes. Please use the secure RORC website or contact the RORC team for help.");
        } else {
          await track(ws, { type: "pin_failed", success: false, errorCode: "pin_mismatch", metadata: { failedAttempts: status.failedAttempts } });
          ws.pinDigits = "";
          speech(ws, `That PIN did not match. You have ${Math.max(0, 3 - status.failedAttempts)} attempts remaining. Please enter the four digits again using your keypad.`);
        }
      } catch (error) {
        ws.awaitingPin = false;
        await track(ws, { type: "pin_error", success: false, error });
        speech(ws, "Private account checks are temporarily unavailable. Please use the secure RORC website or contact the RORC team.");
      } finally { ws.pinDigits = ""; ws.processing = false; }
      return;
    }
    if (message.type !== "prompt" || message.last === false || ws.processing) return;
    const question = toSpeechText(message.voicePrompt).slice(0, 800);
    if (!question) return;
    if (ws.formOffer) {
      const formId = ws.formOffer;
      if (isGuidedFormChoice(question)) {
        beginFormSession(ws, formId);
      } else if (isDirectFormChoice(question) || isYes(question)) {
        ws.formOffer = "";
        ws.processing = true;
        try { await sendFormLink(ws, formId); }
        catch (error) { console.error("RORC form link SMS failed", error); speech(ws, `The secure ${getFormDefinition(formId)?.title || "RORC form"} is available at Ruth Obenchain R C dot com. You can continue there, or ask me another question.`); }
        finally { ws.processing = false; }
      } else if (/^(cancel|never mind|nevermind|no)[.!? ]*$/i.test(question)) {
        ws.formOffer = "";
        speech(ws, "No problem. What else can I help you with?");
      } else {
        speech(ws, "Would you like me to text the form link now, or help fill out the basic information first?");
      }
      return;
    }
    if (ws.formSession) {
      ws.processing = true;
      try { await handleFormAnswer(ws, question); }
      catch (error) { console.error("RORC guided form failed", error); speech(ws, "I had trouble saving that answer. Please try it once more, or say finish online."); }
      finally { ws.processing = false; }
      return;
    }
    if (ws.awaitingTransferReason) {
      ws.awaitingTransferReason = false;
      ws.processing = true;
      try {
        const reply = await answerAndRemember(ws, question, "normal");
        ws.transferOffered = true;
        ws.transferSummary = `The caller asked for Quentin regarding: ${question.slice(0, 160)}`;
        await track(ws, { type: "transfer_offered", metadata: { screened: true } });
        speech(ws, `${reply} Would you still like me to connect you with Quentin?`);
      } catch (error) {
        console.error("RORC transfer screening failed", error);
        await track(ws, { type: "transfer_screening_error", success: false, error });
        speech(ws, "Thank you. Would you like me to connect you with Quentin now?");
        ws.transferOffered = true;
      } finally { ws.processing = false; }
      return;
    }
    if (ws.transferOffered) {
      if (isYes(question)) {
        ws.transferOffered = false;
        ws.finalOutcome = "transferred";
        await track(ws, { type: "transfer_requested" });
        await updateCall(ws.callSid, { outcome: ws.finalOutcome });
        sendApprovedHandoff(ws, ws.transferSummary || "The caller requested RORC staff assistance.");
        return;
      }
      ws.transferOffered = false;
      speech(ws, "No problem. What else can I help you with?");
      return;
    }
    const repeatedReply = repeatConversationReply(question, ws.history);
    if (repeatedReply) {
      ws.history.push({ role: "user", content: question }, { role: "assistant", content: repeatedReply });
      ws.history = ws.history.slice(-10);
      ws.finalOutcome = "answered";
      speech(ws, repeatedReply);
      await track(ws, { type: "contextual_reply", metadata: { kind: "repeat" } });
      return;
    }
    ws.processing = true;
    try {
      const route = await routeIntent(ws, question);
      if (route.needsClarification) {
        const clarification = "I want to make sure I take the right action. Are you asking for information, a text message, help with a form, private account information, or a person?";
        speech(ws, clarification);
        await queueReview(ws, question, clarification, route);
        return;
      }
      if (route.intent === "check_account") {
        await beginAccountCheck(ws);
        await queueReview(ws, question, ws.activeSpeech, route);
        return;
      }
      if (route.intent === "send_information") {
        await sendRequestedSms(ws, question);
        ws.finalOutcome = "sms_sent";
        await queueReview(ws, question, ws.activeSpeech, route);
        return;
      }
      if (route.intent === "start_form") {
        await handleFormIntent(ws, route);
        await queueReview(ws, question, ws.activeSpeech, route);
        return;
      }
      if (route.intent === "request_person") {
        await handlePersonIntent(ws, question);
        await queueReview(ws, question, ws.activeSpeech, route);
        return;
      }
      const reply = await answerAndRemember(ws, question, route.intent === "detailed_explanation" ? "detailed" : "brief", route);
      const unresolved = replyNeedsHuman(reply);
      if (unresolved) {
        ws.transferOffered = true;
        ws.transferSummary = `The website receptionist could not fully resolve: ${question.slice(0, 160)}`;
        await track(ws, { type: "transfer_offered", metadata: { screened: false, reason: "unresolved_answer" } });
        speech(ws, `${reply} If you need personal help with that, I can try connecting you with Quentin. Would you like me to do that?`);
      } else speech(ws, reply);
      await queueReview(ws, question, reply, route, reviewReasons(route, unresolved));
    } catch (error) {
      console.error("RORC receptionist response failed", error);
      await track(ws, { type: "request_error", success: false, error });
      const fallback = "I can still help with RORC hours, memberships, rentals, events, and current gym information. Please say the part you want me to answer first.";
      speech(ws, fallback);
      await queueReview(ws, question, fallback, {}, ["request_error"]);
    } finally { ws.processing = false; }
  });
  ws.on("close", () => {
    Promise.resolve(ws.analyticsReady)
      .then(() => updateCall(ws.callSid, { outcome: ws.finalOutcome, ended: true }))
      .catch((error) => console.error("RORC call completion analytics failed", error));
  });
  ws.on("error", (error) => {
    track(ws, { type: "websocket_error", success: false, error });
  });
});

module.exports = server;
module.exports.websiteContext = websiteContext;
module.exports.liveWebsiteContext = liveWebsiteContext;
module.exports.deterministicLiveAnswer = deterministicLiveAnswer;
module.exports.usefulProviderFallback = usefulProviderFallback;
module.exports.answer = answer;
module.exports.isPersonRequest = isPersonRequest;
module.exports.hasTransferReason = hasTransferReason;
module.exports.replyNeedsHuman = replyNeedsHuman;
module.exports.reviewReasons = reviewReasons;
module.exports.wantsDetailedAnswer = wantsDetailedAnswer;
module.exports.responseLimits = responseLimits;
module.exports.trimAnswerForQuestion = trimAnswerForQuestion;
module.exports.isSmsRequest = isSmsRequest;
module.exports.smsDestination = smsDestination;
module.exports.smsMessageFor = smsMessageFor;
module.exports.repeatConversationReply = repeatConversationReply;
module.exports.isReferentialSmsRequest = isReferentialSmsRequest;
module.exports.normalizeFormAnswer = normalizeFormAnswer;
module.exports.spokenEmail = spokenEmail;
module.exports.spokenDate = spokenDate;
module.exports.spokenTime = spokenTime;
module.exports.spokenNumber = spokenNumber;
module.exports.spokenPhone = spokenPhone;
module.exports.isGuidedFormChoice = isGuidedFormChoice;
