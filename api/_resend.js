const RESEND_API_BASE = "https://api.resend.com";
const MAX_BATCH_SIZE = 100;
const DEFAULT_MAX_RETRIES = 4;
const MAX_RETRY_DELAY_MS = 8000;

async function sendResendEmail({ apiKey, from, to, subject, text, html, replyTo, idempotencyKey }) {
  if (!apiKey) throw new Error("Resend API key is not configured.");
  const body = {
    from,
    to: Array.isArray(to) ? to : [to],
    subject,
    text,
    html,
    ...(replyTo ? { reply_to: replyTo } : {})
  };
  return resendRequest("/emails", {
    apiKey,
    body,
    idempotencyKey
  });
}

async function sendResendBatchEmails({ apiKey, emails, idempotencyKeyPrefix = "rorc-email-batch" }) {
  if (!apiKey) throw new Error("Resend API key is not configured.");
  const normalizedEmails = (emails || [])
    .map(normalizeEmailPayload)
    .filter(Boolean);
  if (!normalizedEmails.length) return { sentCount: 0, responses: [] };

  const responses = [];
  for (let i = 0; i < normalizedEmails.length; i += MAX_BATCH_SIZE) {
    const chunk = normalizedEmails.slice(i, i + MAX_BATCH_SIZE);
    const response = await resendRequest("/emails/batch", {
      apiKey,
      body: chunk,
      idempotencyKey: `${idempotencyKeyPrefix}-${i / MAX_BATCH_SIZE}-${chunk.length}`
    });
    responses.push(response);
  }

  return {
    sentCount: normalizedEmails.length,
    responses
  };
}

function normalizeEmailPayload(email) {
  const to = Array.isArray(email?.to)
    ? email.to.map((value) => String(value || "").trim()).filter(Boolean)
    : [String(email?.to || "").trim()].filter(Boolean);
  const from = String(email?.from || "").trim();
  const subject = String(email?.subject || "").trim();
  if (!from || !to.length || !subject) return null;
  return {
    from,
    to,
    subject,
    ...(email.reply_to || email.replyTo ? { reply_to: email.reply_to || email.replyTo } : {}),
    text: email.text === undefined ? undefined : String(email.text || ""),
    html: email.html === undefined ? undefined : String(email.html || "")
  };
}

async function resendRequest(path, {
  apiKey,
  body,
  idempotencyKey = "",
  maxRetries = DEFAULT_MAX_RETRIES
}) {
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const response = await fetch(`${RESEND_API_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey.slice(0, 256) } : {})
      },
      body: JSON.stringify(body)
    });

    const responseText = await response.text();
    const responseBody = parseJson(responseText);

    if (response.ok) {
      return responseBody || {};
    }

    lastError = new Error(`Resend request failed: ${response.status} ${responseText}`);
    const retryable = isRetryableResendResponse(response.status, responseText);
    if (!retryable || attempt >= maxRetries) {
      throw lastError;
    }

    await sleep(retryDelayMs(response, attempt));
  }

  throw lastError || new Error("Resend request failed.");
}

function isRetryableResendResponse(status, responseText) {
  if (status >= 500) return true;
  if (status !== 429) return false;
  const text = String(responseText || "").toLowerCase();
  return !text.includes("daily_quota_exceeded") && !text.includes("monthly_quota_exceeded");
}

function retryDelayMs(response, attempt) {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(MAX_RETRY_DELAY_MS, Math.ceil(retryAfter * 1000));
  }

  const rateLimitReset = Number(response.headers.get("ratelimit-reset"));
  if (Number.isFinite(rateLimitReset) && rateLimitReset > 0) {
    return Math.min(MAX_RETRY_DELAY_MS, Math.ceil(rateLimitReset * 1000));
  }

  const base = 500 * (2 ** attempt);
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(MAX_RETRY_DELAY_MS, base + jitter);
}

function parseJson(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  sendResendBatchEmails,
  sendResendEmail
};
