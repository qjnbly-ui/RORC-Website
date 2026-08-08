# RORC AI receptionist

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
- `GROQ_RECEPTIONIST_ROUTER_MODEL` — defaults to `openai/gpt-oss-20b`
- `RORC_PUBLIC_BASE_URL` — defaults to `https://www.ruthobenchainrc.com`

The receptionist validates Twilio webhooks and answers from indexed public RORC website content, with selective live lookups for events and facility status. A strict structured router classifies each new top-level request as a simple question, detailed explanation, information delivery, form start, account check, or request for a person. Active PIN, form, and transfer-confirmation states remain deterministic. Narrow regex checks are retained only as a low-confidence or provider-failure safety fallback.

It screens requests for Quentin, asks what the call concerns when needed, and requires clear confirmation before transferring. For account questions, it matches the caller's number to one RORC member account and verifies the existing four-digit account PIN through keypad entry. Three failed entries within 15 minutes lock that caller's account checks for 30 minutes across calls. When a caller explicitly requests a text/link or chooses guided form help after being told a link will be sent, that request is recorded as voice consent and the receptionist sends without asking for a second confirmation. It then says what it sent. START, STOP, and HELP remain supported by text. Account information is read-only and the receptionist does not trigger heater controls.

The welcome greeting tells callers they can press `0` at any time to leave a voicemail. Zero is handled globally, including during the greeting, AI speech, account PIN entry, guided forms, and transfer screening. The AI session hands the live call back to Twilio, announces that the message will be recorded, and records up to three minutes with `#` as the finish key. Completed recordings remain in Twilio Voice Recordings; receptionist analytics retain only the recording SID, status, and duration, not the audio URL or a transcription. An unavailable live transfer falls back to the same voicemail flow.

Call analytics use an HMAC caller identifier rather than a stored phone number. Top-level wording used by the router is retained for seven days, while structured call metadata is retained for 180 days. PIN digits, DTMF input, guided-form answers, passwords, signatures, and payment details are never written to receptionist analytics. Account Managers can review aggregate reliability and recent routing issues in the RORC App. The daily cleanup endpoint removes expired drafts and stale analytics; it is authenticated by `CRON_SECRET`.

Public website knowledge is rebuilt deterministically on every Vercel deployment through the `vercel-build` script. Run `npm run check:receptionist-knowledge` to detect a stale committed artifact and `npm run eval:receptionist` for the opt-in live Groq intent evaluation.

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
