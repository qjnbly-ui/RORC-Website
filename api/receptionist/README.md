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

Optional variables:

- `RORC_RECEPTIONIST_GREETING`
- `TWILIO_RECEPTIONIST_VOICE`
- `GROQ_RECEPTIONIST_MODEL`

The receptionist validates Twilio webhooks and answers from indexed public RORC website content, with selective live lookups for events and facility status. It screens requests for Quentin, asks what the call concerns when needed, and requires clear confirmation before transferring. For account questions, it matches the caller's number to one RORC member account and verifies the existing four-digit account PIN through keypad entry. When a caller explicitly requests a text/link or chooses guided form help after being told a link will be sent, that request is recorded as voice consent and the receptionist sends without asking for a second confirmation. It then says what it sent. START, STOP, and HELP remain supported by text. Account information is read-only and the receptionist does not trigger heater controls or write call transcripts to Supabase.

## Guided forms

The receptionist supports the public membership signup, facility rental, and banner sponsorship forms. It offers to either text the direct form link or collect safe prefill fields and text a secure completion link. Callers may skip a field, finish online early, or cancel and discard the call's answers.

Guided answers are parsed locally by the RORC server and are not sent to the general-answer AI model. The workflow never collects passwords, four-digit PINs, dates of birth, signatures, contract acknowledgements, payment-card details, or file uploads by phone. Drafts use a hashed 256-bit bearer token, are available only through the server-side endpoint, and expire after seven days. The browser removes the token fragment from the address bar after loading the draft.
