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
const { liveContextText, loadReceptionistLiveData } = require("./live-data");
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
import type { DetailLevel, FetchOptions, FormSession, HistoryItem, IntentResult, LiveSnapshot } from "./contracts";
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
interface KnowledgePage { title: string; route: string; text: string; index: number }
const siteKnowledge = require("../../api/rorc-site-knowledge.json") as { contentHash?: string; generatedAt?: string; pages: KnowledgePage[] };

const KNOWLEDGE_VERSION = String(siteKnowledge.contentHash || siteKnowledge.generatedAt || "unknown").slice(0, 80);
const PROMPT_VERSION = "rorc-receptionist-2026-08-12-review-v1";
const ROUTER_MODEL = String(process.env.GROQ_RECEPTIONIST_ROUTER_MODEL || "openai/gpt-oss-20b");
const ANSWER_MODEL = String(process.env.GROQ_RECEPTIONIST_MODEL || "openai/gpt-oss-120b");
const ANSWER_FALLBACK_MODEL = String(process.env.GROQ_RECEPTIONIST_FALLBACK_MODEL || ROUTER_MODEL);
const ANSWER_MODEL_VERSION = `${ANSWER_MODEL}|fallback:${ANSWER_FALLBACK_MODEL}`.slice(0, 120);

const RULES = [
  "You are the warm AI receptionist for the Ruth Obenchain Recreation Center, commonly called RORC, in Bly, Oregon.",
  "Use the supplied RORC website context as the source of truth and answer as capably as someone navigating the public website for the caller.",
  "Live facility and event data is supplied on every public-information request. Use it whenever it answers the caller, regardless of the caller's wording.",
  "When live data is marked stale, describe it as the latest recorded information rather than current information.",
  "Answer only the question the caller actually asked. For a simple yes-or-no question, answer in one or two short sentences.",
  "Give a direct, useful answer before suggesting a page. Explain steps, requirements, prices, policies, hours, events, rentals, memberships, projects, sponsorships, and other public information only when the caller asks for those details.",
  "Do not recite an entire webpage or add unrelated requirements. For example, do not explain alcohol insurance, every rental rule, or the full application process unless the caller asks about it.",
  "Keep ordinary answers to one to four clear spoken sentences, but use more when the caller requests detail. Never use markdown, bullets, raw URLs, or symbols. Say the website as Ruth Obenchain R C dot com.",
  "Do not invent prices, hours, availability, reservations, policies, or account details. Do not request passwords, payment-card details, or other sensitive information.",
  "Do not mention or offer Quentin unless the caller asks for him or another person, or the supplied information is genuinely insufficient for a request requiring personal help.",
  "Private account information is handled separately after caller recognition and keypad PIN verification.",
].join(" ");

const STOP_WORDS = new Set("a an and are as at be by can do for from had has have how i if in is it me my of on or our that the their they this to was we what when where which who why will with you your".split(" "));
const SMS_ROUTES = [
  { url: "https://www.ruthobenchainrc.com/sponsors/form/", pattern: /\b(sponsor|sponsorship|banner)\b.{0,50}\b(form|apply|application|submit|renew)\b/i },
  { url: "https://www.ruthobenchainrc.com/membership-signup/", pattern: /\b(sign ?up|signing up|join|enroll|registration|start (?:a |my |new )?membership|become a member)\b/i },
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

function searchTerms(value: unknown): string[] {
  return [...new Set(String(value || "").toLowerCase().match(/[a-z0-9']{2,}/g) || [])].filter((word) => !STOP_WORDS.has(word));
}

function websiteContext(question: string): string {
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
  const ranked = siteKnowledge.pages.map((page: KnowledgePage) => {
    const haystack = `${page.title} ${page.route} ${page.text}`.toLowerCase();
    const termScore = terms.reduce((total, term) => total + (haystack.includes(term) ? (page.title.toLowerCase().includes(term) ? 5 : 2) : 0), 0);
    const score = termScore + (boostedRoutes.has(page.route) ? 20 : 0);
    return { page, score };
  }).sort((a: { page: KnowledgePage; score: number }, b: { page: KnowledgePage; score: number }) => b.score - a.score || a.page.index - b.page.index);
  const selected = ranked.filter((item: { page: KnowledgePage; score: number }) => item.score > 0).slice(0, 7);
  const fallback = selected.length ? selected : ranked.slice(0, 3);
  return fallback.map(({ page }: { page: KnowledgePage }) => `Page ${page.title} (${page.route}): ${page.text}`).join("\n\n").slice(0, 18000);
}

async function liveWebsiteContext(options: FetchOptions = {}): Promise<string> {
  return liveContextText(await loadReceptionistLiveData(options));
}

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

function wantsDetailedAnswer(value: unknown): boolean {
  return /\b(explain|details?|everything|all (?:the )?(?:information|rules|requirements|options)|step by step|walk me through|full process|in depth|compare|requirements|rules|polic(?:y|ies))\b/i.test(String(value || ""));
}

function isSimpleQuestion(value: unknown): boolean {
  return /^(?:is|are|am|can|could|do|does|did|will|would|has|have|should|may)\b/i.test(String(value || "").trim());
}

function responseLimits(question: string, detailLevel: DetailLevel | "" = ""): { maxTokens: number; maxSentences: number } {
  if (detailLevel === "detailed") return { maxTokens: 600, maxSentences: 10 };
  if (detailLevel === "brief") return { maxTokens: 110, maxSentences: 3 };
  if (wantsDetailedAnswer(question)) return { maxTokens: 600, maxSentences: 10 };
  if (isSimpleQuestion(question)) return { maxTokens: 90, maxSentences: 2 };
  return { maxTokens: 220, maxSentences: 4 };
}

function responseModeInstruction(question: string, detailLevel: DetailLevel | "" = ""): string {
  if (detailLevel === "detailed") return "The caller requested detail. Give a focused explanation of only that topic in no more than ten spoken sentences.";
  if (detailLevel === "brief") return "Answer directly in no more than three short spoken sentences. Do not add adjacent rules, prices, requirements, or process details unless needed for the exact answer.";
  if (wantsDetailedAnswer(question)) return "The caller explicitly requested detail. Give a focused explanation covering only that requested topic.";
  if (isSimpleQuestion(question)) return "This is a simple direct question. Answer it immediately in no more than two short sentences. Do not add prices, rules, exceptions, application steps, insurance information, or other page content unless needed to answer the exact question.";
  return "Give a focused answer in no more than four sentences. Include only information needed for the exact question and omit adjacent webpage content.";
}

function trimAnswerForQuestion(value: unknown, question: string, detailLevel: DetailLevel | "" = ""): string {
  const clean = toSpeechText(value);
  const sentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
  const { maxSentences } = responseLimits(question, detailLevel);
  return sentences.slice(0, maxSentences).join(" ").replace(/\s+/g, " ").trim();
}

function smsDestination(question: string, history: HistoryItem[] = []): string {
  const current = String(question || "");
  const recent = history.slice(-6).map((item) => String(item?.content || "")).join(" ");
  return SMS_ROUTES.find(({ pattern }) => pattern.test(current))?.url
    || SMS_ROUTES.find(({ pattern }) => pattern.test(recent))?.url
    || "https://www.ruthobenchainrc.com/";
}

function smsMessageFor(question: string, history: HistoryItem[] = []): { body: string; confirmation: string } {
  const link = smsDestination(question, history);
  const context = `${question} ${history.slice(-6).map((item) => item?.content || "").join(" ")}`;
  if (/\b(direction|address|location|where are you|how do i get there)\b/i.test(context)) {
    return { body: `RORC Location\n19140 Edler Street, Bly, Oregon\n\n${link}\n\nReply STOP to opt out or HELP for help.`, confirmation: "the RORC address and website link" };
  }
  const messages: Record<string, [string, string]> = {
    "https://www.ruthobenchainrc.com/membership-signup/": [
      "RORC Membership Signup\nOpen Gym: $2 one-time. Weight Room: $10/month. Full Facility: $20/month. Full Facility + Wi-Fi: $25/month. Start your signup here:",
      "membership options and the signup link",
    ],
    "https://www.ruthobenchainrc.com/memberships/": ["RORC Memberships\nCompare membership options, pricing, access, and benefits here:", "membership information and pricing"],
    "https://www.ruthobenchainrc.com/rentals/": ["RORC Facility Rentals\nReview rental options, pricing, live availability, and start a rental application here:", "facility rental information and application link"],
    "https://www.ruthobenchainrc.com/events/": ["RORC Events\nSee upcoming events and the current RORC schedule here:", "RORC events page"],
    "https://www.ruthobenchainrc.com/sponsors/form/": ["RORC Banner Sponsorship\nStart a new banner sponsorship or submit a renewal here:", "banner sponsorship form"],
    "https://www.ruthobenchainrc.com/sponsors/": ["Support RORC\nView sponsorship opportunities and ways to support RORC here:", "RORC sponsorship information"],
    "https://www.ruthobenchainrc.com/work-exchange/": ["RORC Work Exchange\nReview the work-exchange program and participation details here:", "work-exchange information"],
    "https://www.ruthobenchainrc.com/projects/": ["RORC Projects\nSee current renovation and improvement projects here:", "RORC projects page"],
    "https://www.ruthobenchainrc.com/windows/": ["RORC History Windows\nLearn about the community history window project here:", "history windows page"],
    "https://www.ruthobenchainrc.com/about-rorc/": ["About RORC\nRead the recreation center's history, mission, and community story here:", "About RORC page"],
    "https://www.ruthobenchainrc.com/support/": ["RORC Support\nCall (541) 652-6065 or find contact and support information here:", "RORC contact information"],
    "https://www.ruthobenchainrc.com/privacy-policy/": ["RORC Privacy Policy\nRead how RORC collects, uses, and protects information here:", "RORC privacy policy"],
    "https://www.ruthobenchainrc.com/terms-of-service/": ["RORC Terms of Service\nReview the current terms, policies, and responsibilities here:", "RORC terms of service"],
    "https://www.ruthobenchainrc.com/": ["RORC Website\nFind memberships, rentals, events, facility information, and support here:", "RORC website link"],
  };
  const [copy, confirmation] = messages[link] || messages["https://www.ruthobenchainrc.com/"]!;
  return { body: `${copy}\n\n${link}\n\nReply STOP to opt out or HELP for help.`, confirmation };
}

function priorAnswer(history: HistoryItem[] = []): string {
  return [...history].reverse().find((item) => item?.role === "assistant" && item.content)?.content || "";
}

function isReferentialSmsRequest(question: string): boolean {
  const text = String(question || "");
  return /\b(send|share|forward|text|message)\b.{0,80}\b(that|it|this|the link|that link|this link)\b/i.test(text)
    && !SMS_ROUTES.some(({ pattern }) => pattern.test(text));
}

interface AnswerModelRequest {
  key: string;
  models: string[];
  question: string;
  history: HistoryItem[];
  detailLevel: DetailLevel;
  siteContext: string;
  liveContext: string;
  fetcher?: typeof fetch;
}
interface AnswerOptions {
  apiKey?: string;
  liveSnapshot?: LiveSnapshot;
  liveOptions?: FetchOptions;
  fetch?: typeof fetch;
}
async function requestAnswerModel({ key, models, question, history, detailLevel, siteContext, liveContext, fetcher = fetch }: AnswerModelRequest): Promise<string> {
  const limits = responseLimits(question, detailLevel);
  let lastError;
  for (const model of [...new Set(models.filter(Boolean))]) {
    try {
      const response = await fetcher("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, temperature: 0.1, max_tokens: limits.maxTokens, messages: [{ role: "system", content: `${RULES}\n\nCURRENT PUBLIC RORC WEBSITE CONTEXT:\n${siteContext}${liveContext ? `\n\n${liveContext}` : ""}\n\nQUESTION-SPECIFIC RESPONSE MODE: ${responseModeInstruction(question, detailLevel)}` }, ...history.slice(-8), { role: "user", content: question }] }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.message || "AI response failed");
      const reply = trimAnswerForQuestion(data?.choices?.[0]?.message?.content, question, detailLevel);
      if (reply) return reply;
      throw new Error("AI response was empty");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("AI response failed");
}

async function answer(question: string, history: HistoryItem[], detailLevel: DetailLevel = "normal", route: Partial<IntentResult> = {}, options: AnswerOptions = {}): Promise<string> {
  const key = String(options.apiKey ?? process.env.GROQ_API_KEY ?? "").trim();
  const requestedSources = route?.live_data === "facility" ? ["facility"]
    : route?.live_data === "events" ? ["events"]
      : ["facility", "events"];
  const [siteContext, liveSnapshot] = await Promise.all([
    Promise.resolve(websiteContext(question)),
    options.liveSnapshot ? Promise.resolve(options.liveSnapshot) : loadReceptionistLiveData({ ...(options.liveOptions || {}), sources: requestedSources }),
  ]);
  const direct = deterministicLiveAnswer(route, liveSnapshot);
  if (direct) return direct;
  const liveContext = liveContextText(liveSnapshot);
  if (!key) return usefulProviderFallback(route, liveSnapshot, siteContext);
  try {
    return await requestAnswerModel({
      key,
      models: [
        ANSWER_MODEL,
        ANSWER_FALLBACK_MODEL,
      ],
      question,
      history,
      detailLevel,
      siteContext,
      liveContext,
      fetcher: options.fetch || fetch,
    });
  } catch (error) {
    console.error("RORC answer providers unavailable", error);
    return usefulProviderFallback(route, liveSnapshot, siteContext);
  }
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
module.exports.isReferentialSmsRequest = isReferentialSmsRequest;
module.exports.normalizeFormAnswer = normalizeFormAnswer;
module.exports.spokenEmail = spokenEmail;
module.exports.spokenDate = spokenDate;
module.exports.spokenTime = spokenTime;
module.exports.spokenNumber = spokenNumber;
module.exports.spokenPhone = spokenPhone;
module.exports.isGuidedFormChoice = isGuidedFormChoice;
