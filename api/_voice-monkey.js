const { resolveVoiceMonkeyUrl } = require("./_automation-security");

const VOICE_MONKEY_V3_ORIGIN = "https://api-v3.voicemonkey.io";

function voiceMonkeyApiVersion() {
  const value = String(process.env.VOICEMONKEY_API_VERSION || "v2").trim().toLowerCase();
  if (value === "v2" || value === "v3") return value;
  throw new Error("VOICEMONKEY_API_VERSION must be either v2 or v3.");
}

function resolveVoiceMonkeyDevice({ settingValue, environmentName, label }) {
  const raw = String(process.env[environmentName] || settingValue || "").trim();
  if (!raw) throw new Error(`${label} is not configured.`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(raw)) {
    throw new Error(`${label} is not a valid VoiceMonkey device ID.`);
  }
  return raw;
}

function voiceMonkeyToken() {
  const token = String(process.env.VOICEMONKEY_API_TOKEN || "").trim();
  if (!token) throw new Error("VoiceMonkey v3 API access is not configured.");
  return token;
}

async function callVoiceMonkeyV3(path, payload, fetcher = fetch, {
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => Date.now()
} = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetcher(`${VOICE_MONKEY_V3_ORIGIN}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${voiceMonkeyToken()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) return body || { success: true };

    const providerError = String(body?.error || body?.message || "VoiceMonkey request failed.").trim();
    const lockoutUntil = Date.parse(String(body?.lockoutUntil || ""));
    if (response.status === 429 && providerError === "THROTTLED" && attempt === 0) {
      const waitMs = Number.isFinite(lockoutUntil)
        ? Math.min(15000, Math.max(250, lockoutUntil - now() + 100))
        : 1000;
      await sleep(waitMs);
      continue;
    }
    throw new Error(`VoiceMonkey v3 request failed: ${response.status} ${providerError}`);
  }
  throw new Error("VoiceMonkey v3 request failed after a safe throttle retry.");
}

async function triggerVoiceMonkey({
  v3Device,
  v3EnvironmentName,
  legacySettingValue,
  legacyEnvironmentName,
  label,
  fetcher = fetch
}) {
  if (voiceMonkeyApiVersion() === "v3") {
    const device = resolveVoiceMonkeyDevice({
      settingValue: v3Device,
      environmentName: v3EnvironmentName,
      label: `${label} v3 device`
    });
    return callVoiceMonkeyV3("/trigger", { device }, fetcher);
  }

  const url = resolveVoiceMonkeyUrl({
    settingValue: legacySettingValue,
    environmentName: legacyEnvironmentName,
    label
  });
  const response = await fetcher(url, { method: "GET" });
  if (!response.ok) throw new Error(`${label} failed: ${response.status} ${await response.text()}`);
  return { success: true };
}

async function announceVoiceMonkey({
  v3Device,
  v3EnvironmentName,
  speech,
  voice,
  chime,
  characterDisplay,
  legacySettingValue,
  legacyEnvironmentName,
  label,
  fetcher = fetch
}) {
  if (voiceMonkeyApiVersion() === "v3") {
    const device = resolveVoiceMonkeyDevice({
      settingValue: v3Device,
      environmentName: v3EnvironmentName,
      label: `${label} v3 device`
    });
    const normalizedSpeech = String(speech || "").trim();
    if (!normalizedSpeech) throw new Error(`${label} speech is not configured.`);
    const payload = { device, speech: normalizedSpeech };
    if (String(voice || "").trim()) payload.voice = String(voice).trim();
    if (String(chime || "").trim()) payload.chime = String(chime).trim();
    if (String(characterDisplay || "").trim()) {
      payload.character_display = String(characterDisplay).trim();
    }
    return callVoiceMonkeyV3("/announce", payload, fetcher);
  }

  const url = resolveVoiceMonkeyUrl({
    settingValue: legacySettingValue,
    environmentName: legacyEnvironmentName,
    label
  });
  const response = await fetcher(url, { method: "GET" });
  if (!response.ok) throw new Error(`${label} failed: ${response.status} ${await response.text()}`);
  return { success: true };
}

module.exports = {
  VOICE_MONKEY_V3_ORIGIN,
  announceVoiceMonkey,
  callVoiceMonkeyV3,
  resolveVoiceMonkeyDevice,
  triggerVoiceMonkey,
  voiceMonkeyApiVersion
};
