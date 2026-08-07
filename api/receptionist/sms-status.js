const { validateTwilioWebhook } = require("../_twilio-webhook");
const { updateMessageStatus } = require("../_receptionist-analytics");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed.");
  if (!validateTwilioWebhook(req)) return res.status(403).send("Invalid Twilio signature.");

  const messageSid = String(req.body?.MessageSid || "").trim();
  const status = String(req.body?.MessageStatus || "unknown").trim().toLowerCase();
  const errorCode = String(req.body?.ErrorCode || "").trim();
  if (messageSid) {
    await updateMessageStatus(messageSid, status, { code: errorCode }).catch((error) => {
      console.error("RORC SMS delivery analytics failed", error);
    });
  }
  return res.status(204).send("");
};
