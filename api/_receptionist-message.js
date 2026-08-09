const { sendResendEmail } = require("./_resend");
const { normalizePhone, sendSms } = require("./_rorc-sms");

function messageDeliveryConfig() {
  return {
    smsNumber: normalizePhone(
      process.env.RORC_RECEPTIONIST_MESSAGE_NUMBER
      || process.env.RORC_RECEPTIONIST_TRANSFER_NUMBER
    ),
    emailAddress: String(
      process.env.RORC_RECEPTIONIST_MESSAGE_EMAIL
      || process.env.RORC_NOTIFY_EMAIL
      || "quentin.nichols@ruthobenchainrc.com"
    ).trim(),
    resendApiKey: String(process.env.RESEND_API_KEY || "").trim(),
    resendFrom: String(
      process.env.RESEND_FROM_EMAIL
      || "RORC App <no-reply@ruthobenchainrc.com>"
    ).trim(),
  };
}

function callerContact(caller, fromNumber, suppliedName = "") {
  const recognized = caller && !caller.ambiguous ? caller.member : null;
  return {
    name: String(recognized?.member_name || suppliedName || "").trim().slice(0, 120),
    phone: normalizePhone(fromNumber),
    email: String(recognized?.email_address || "").trim().toLowerCase().slice(0, 254),
  };
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function staffMessageContent({ message, contact }) {
  const safeMessage = String(message || "").trim().slice(0, 1600);
  const name = String(contact?.name || "Unknown caller").trim();
  const phone = normalizePhone(contact?.phone) || "Not available";
  const email = String(contact?.email || "").trim() || "Not available";
  const text = [
    "New RORC phone message",
    `From: ${name}`,
    `Phone: ${phone}`,
    `Email: ${email}`,
    "",
    safeMessage,
  ].join("\n");
  const html = `
    <div style="font-family:Arial,sans-serif;background:#111;color:#f5f5f5;padding:24px;">
      <div style="max-width:680px;margin:0 auto;background:#1b1b1b;border:1px solid #333;border-radius:14px;padding:24px;">
        <h2 style="margin:0 0 18px;">New RORC Phone Message</h2>
        <p><strong>From:</strong> ${escapeHtml(name)}</p>
        <p><strong>Phone:</strong> ${escapeHtml(phone)}</p>
        <p><strong>Email:</strong> ${escapeHtml(email)}</p>
        <div style="margin-top:20px;padding:16px;border-left:4px solid #f23a36;background:#151515;line-height:1.65;white-space:pre-wrap;">${escapeHtml(safeMessage)}</div>
      </div>
    </div>
  `;
  return { email, html, name, phone, safeMessage, text };
}

async function deliverReceptionistMessage(payload, dependencies = {}) {
  const config = dependencies.config || messageDeliveryConfig();
  const sendSmsFn = dependencies.sendSmsFn || sendSms;
  const sendEmailFn = dependencies.sendEmailFn || sendResendEmail;
  const content = staffMessageContent(payload);
  const deliveries = [];

  if (config.smsNumber) {
    deliveries.push({
      channel: "text",
      promise: sendSmsFn(config.smsNumber, content.text),
    });
  }
  if (config.resendApiKey && config.emailAddress) {
    deliveries.push({
      channel: "email",
      promise: sendEmailFn({
        apiKey: config.resendApiKey,
        from: config.resendFrom,
        to: [config.emailAddress],
        replyTo: content.email !== "Not available" ? [content.email] : undefined,
        subject: `[RORC Phone Message] ${content.name}`,
        text: content.text,
        html: content.html,
        idempotencyKey: `receptionist-message-${String(payload.callSid || "unknown").slice(0, 80)}`,
      }),
    });
  }
  if (!deliveries.length) throw new Error("Quentin's message delivery is not configured.");

  const results = await Promise.allSettled(deliveries.map((delivery) => delivery.promise));
  const sentChannels = deliveries
    .filter((_delivery, index) => results[index].status === "fulfilled")
    .map((delivery) => delivery.channel);
  if (!sentChannels.length) {
    const failure = results.find((result) => result.status === "rejected");
    throw failure?.reason || new Error("The message could not be delivered.");
  }
  return {
    emailSent: sentChannels.includes("email"),
    textSent: sentChannels.includes("text"),
  };
}

module.exports = {
  callerContact,
  deliverReceptionistMessage,
  messageDeliveryConfig,
  staffMessageContent,
};
