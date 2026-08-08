const { recordEvent, updateCall } = require("../_receptionist-analytics");
const { validateTwilioWebhook } = require("../_twilio-webhook");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed.");
  if (!validateTwilioWebhook(req)) return res.status(403).send("Invalid Twilio signature.");

  const callSid = String(req.body?.CallSid || "").trim();
  const recordingSid = String(req.body?.RecordingSid || "").trim();
  const recordingStatus = String(req.body?.RecordingStatus || "unknown").trim().toLowerCase();
  const durationSeconds = Math.max(0, Number(req.body?.RecordingDuration || 0) || 0);
  const completed = recordingStatus === "completed" && Boolean(recordingSid);

  try {
    await Promise.all([
      recordEvent(callSid, {
        type: "voicemail_recording",
        success: completed,
        errorCode: completed ? "" : `recording_${recordingStatus}`,
        metadata: { recordingSid, recordingStatus, durationSeconds },
      }),
      updateCall(callSid, { outcome: completed ? "voicemail" : "voicemail_failed" }),
    ]);
  } catch (error) {
    console.error("RORC voicemail analytics failed", error);
  }
  return res.status(204).end();
};
