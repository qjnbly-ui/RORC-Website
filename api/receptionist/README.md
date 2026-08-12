# RORC AI receptionist

## What the phone system actually uses

Twilio ConversationRelay is the managed voice bridge already selected by the `<ConversationRelay>` element in `api/receptionist/incoming.js`. Deepgram is its configured speech-to-text provider and ElevenLabs is its configured text-to-speech provider. They are not separate servers or databases in this repository, and there is no Deepgram WebSocket service for RORC to maintain. Twilio opens the signed WebSocket connection to `/api/receptionist/conversation`; the RORC server receives typed events and returns text for Twilio to speak.

The new core is TypeScript under `src/receptionist/`:

- `contracts.ts` — shared intent, live-data, form, and call contracts
- `router.ts` — structured intent routing and deterministic fallback routing
- `live-data.ts` — live facility/event loading, retries, and recent-good-value cache
- `live-answers.ts` — deterministic temperature, occupancy, trend, and event answers
- `form-input.ts` — local parsing for spoken dates, times, phones, email, and form choices
- `protocol.ts` — ConversationRelay inbound/outbound message validation
- `state.ts` — a new isolated state object for every call
- `conversation-server.ts` — the orchestration layer that connects the modules

The three existing JavaScript files at `api/_receptionist-router.js`, `api/_receptionist-live-data.js`, and `api/receptionist/conversation.js` are intentionally tiny deployment adapters. TypeScript compiles to the ignored `.build/` directory before tests and every Vercel deployment, so existing endpoint URLs do not change.

Set the RORC Twilio number's incoming voice webhook to:

`https://www.ruthobenchainrc.com/api/receptionist/incoming`

Set the RORC Twilio number's incoming messaging webhook to:

`https://www.ruthobenchainrc.com/api/receptionist/sms`

Use the canonical `www` hostname directly for both webhooks. The non-`www` domain redirects, which can invalidate Twilio's URL-specific webhook signature.

Required Vercel environment variables:

- `TWILIO_ACCOUNT_SID` — the RORC Twilio account SID
- `TWILIO_AUTH_TOKEN` — the RORC Twilio auth token
- `GROQ_API_KEY` — the approved AI response provider key
- `RORC_RECEPTIONIST_TRANSFER_NUMBER` — the phone number for approved live handoffs
- `RORC_RECEPTIONIST_NUMBER` — the RORC Twilio number used as the SMS sender
- `RORC_RECEPTIONIST_SECURITY_SECRET` — a random secret of at least 32 characters used to HMAC caller numbers for persistent PIN security and analytics
- `CRON_SECRET` — a random secret of at least 16 characters used by Vercel to authenticate cleanup jobs

Optional variables:

- `RORC_RECEPTIONIST_GREETING`
- `TWILIO_RECEPTIONIST_VOICE`
- `GROQ_RECEPTIONIST_MODEL`
- `GROQ_RECEPTIONIST_FALLBACK_MODEL` — defaults to the router model and is tried if the primary answer model is unavailable
- `GROQ_RECEPTIONIST_ROUTER_MODEL` — defaults to `openai/gpt-oss-20b`
- `RORC_PUBLIC_BASE_URL` — defaults to `https://www.ruthobenchainrc.com`

The receptionist validates Twilio webhooks and answers from indexed public RORC website content. Cached live facility and event data is loaded as a first-class capability for every public-information answer, rather than being gated by a list of caller phrases. Requests are retried, and a recent successful snapshot can be used when a live dependency has a short outage. A strict structured router classifies each new top-level request as a simple question, detailed explanation, information delivery, form start, account check, or request for a person. It also labels live facts semantically. Temperature, humidity, occupancy, traffic patterns, check-in totals, and member counts are answered directly from structured data without relying on the general-answer model to interpret JSON. Active PIN, form, and transfer-confirmation states remain deterministic. Narrow regex checks are retained only as a low-confidence or provider-failure safety fallback.

It screens requests for Quentin, asks what the call concerns when needed, and requires clear confirmation before transferring. For account questions, it matches the caller's number to one RORC member account and verifies the existing four-digit account PIN through keypad entry. Three failed entries within 15 minutes lock that caller's account checks for 30 minutes across calls. When a caller explicitly requests a text/link or chooses guided form help after being told a link will be sent, that request is recorded as voice consent and the receptionist sends without asking for a second confirmation. It then says what it sent. START, STOP, and HELP remain supported by text. Account information is read-only and the receptionist does not trigger heater controls.

Call analytics use an HMAC caller identifier rather than a stored phone number. Top-level wording used by the router is retained for seven days, while structured call metadata is retained for 180 days. PIN digits, DTMF input, guided-form answers, passwords, signatures, and payment details are never written to receptionist analytics. Low-confidence, fallback, clarification, unresolved, and failed turns enter an Account Manager-only review queue with the caller wording and receptionist response; those review items also expire after seven days. Ordinary successful answers are not copied into the queue. The daily cleanup endpoint removes expired drafts, review items, and stale analytics; it is authenticated by `CRON_SECRET`.

Public website knowledge is rebuilt deterministically on every Vercel deployment through the `vercel-build` script. Run `npm run check:receptionist-knowledge` to detect a stale committed artifact and `npm run eval:receptionist` for the opt-in live Groq intent evaluation.

## Controlled improvement reviews

The **AI Receptionist** page lets an Account Manager dismiss a flagged turn as correct or record the issue and the behavior that should have occurred. A correction changes no production prompt, workflow, or model automatically. The manager can separately opt in to a persistent regression case after sanitizing the reusable caller wording and adding an expected intent, required answer phrases, or forbidden answer phrases.

Run `npm run sync:receptionist-feedback-evals` with server-side Supabase access to refresh `tests/fixtures/receptionist-feedback-evals.json` from approved cases. Commit that reviewed fixture, then run `npm run eval:receptionist-feedback` with `GROQ_API_KEY` before releasing a related receptionist change. Call records include the prompt, router model, answer model, and knowledge versions so before-and-after results can be attributed to the correct release.

## Safe changes and rollout

Every pull request now has four independent gates: strict TypeScript checking, the complete repository test suite, minimum receptionist core coverage, and the production asset build. The protocol suite checks ConversationRelay frame parsing, signed WebSocket behavior, handoff approval, and per-call state isolation. The intent fixture tests many natural phrasings rather than adding a special rule for each sentence.

Deploy a branch to a Vercel preview first. Run `RORC_SMOKE_BASE_URL=https://your-preview.example TWILIO_AUTH_TOKEN=... npm run smoke:receptionist`, or manually run the CI workflow with the preview URL. The smoke checks facility/event APIs and asks the deployed WebSocket the two historically unreliable questions: current gym temperature and busiest time. Only after that passes should a staging Twilio number's voice webhook be pointed at the preview `/api/receptionist/incoming` URL for real audio checks. Production remains on the current deployment until the staging call passes, and Vercel's prior deployment remains the rollback point.

ConversationRelay failures are allowed one clean reconnect. A live transfer occurs only when the server sends an explicit `approved-rorc-transfer` handoff after the caller confirms it; an ordinary relay disconnect can no longer accidentally dial the transfer number.

## Guided forms

The receptionist supports the public membership signup, facility rental, and banner sponsorship forms. It offers to either text the direct form link or collect safe prefill fields and text a secure completion link. Callers may skip a field, finish online early, or cancel and discard the call's answers.

Guided answers are parsed locally by the RORC server and are not sent to the general-answer AI model. The workflow never collects passwords, four-digit PINs, dates of birth, signatures, contract acknowledgements, payment-card details, or file uploads by phone. Drafts use a hashed 256-bit bearer token, are available only through the server-side endpoint, and expire after seven days. The browser removes the token fragment from the address bar after loading the draft.

## Staff calls and messages

The Account Manager-only **Calls & Messages** page is intentionally separate from member notifications, scheduled messages, and receptionist analytics. Ordinary inbound SMS messages received by the existing `/api/receptionist/sms` webhook are copied into the staff inbox. START, STOP, and HELP keep their existing behavior.

Outgoing browser calls use a separate TwiML App and do not change the RORC number's incoming voice webhook. Configure that TwiML App's Voice Request URL as:

`https://www.ruthobenchainrc.com/api/communications-voice-outbound`

Add these Vercel environment variables for outbound browser calling:

- `TWILIO_API_KEY_SID` — a Twilio API key SID used only to mint short-lived Voice access tokens
- `TWILIO_API_KEY_SECRET` — the corresponding API key secret
- `TWILIO_TWIML_APP_SID` — the SID of the outbound-only TwiML App above

The Voice access token sets `incomingAllow` to false. Incoming calls continue to use `/api/receptionist/incoming` and remain answered by the AI receptionist.
