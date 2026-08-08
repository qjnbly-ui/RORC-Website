const { publicHttpUrl } = require("./_receptionist");

const VOICEMAIL_MAX_SECONDS = 180;

function parseHandoffData(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isVoicemailHandoff(req) {
  return parseHandoffData(req?.body?.HandoffData || req?.query?.HandoffData).reasonCode === "voicemail";
}

function appendVoicemailRecording(response, req, intro = "Please leave your message after the beep.") {
  response.say(
    { voice: "alice" },
    `${intro} Your message will be recorded for the RORC team. Press pound when you are finished.`
  );
  response.record({
    action: publicHttpUrl(req, "/api/receptionist/voicemail-complete"),
    method: "POST",
    timeout: 10,
    finishOnKey: "#",
    maxLength: VOICEMAIL_MAX_SECONDS,
    playBeep: true,
    trim: "trim-silence",
    recordingStatusCallback: publicHttpUrl(req, "/api/receptionist/voicemail-status"),
    recordingStatusCallbackMethod: "POST",
    recordingStatusCallbackEvent: "completed absent",
  });
}

module.exports = {
  VOICEMAIL_MAX_SECONDS,
  appendVoicemailRecording,
  isVoicemailHandoff,
  parseHandoffData,
};
