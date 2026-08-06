# RORC AI receptionist

Set the RORC Twilio number's incoming voice webhook to:

`https://ruthobenchainrc.com/api/receptionist/incoming`

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

The receptionist validates Twilio webhooks, answers general RORC questions, offers a transfer to Quentin after every helpful answer, and requires a clear caller confirmation before sending the call to the transfer number. For account questions, it matches the caller's number to one RORC member account and verifies the existing four-digit account PIN through keypad entry. Callers can provide SMS consent verbally during the call or by texting START. STOP and HELP are supported. Account information is read-only and the receptionist does not trigger heater controls or write call transcripts to Supabase.
