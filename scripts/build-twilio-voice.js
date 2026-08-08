const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "node_modules", "@twilio", "voice-sdk", "dist", "twilio.min.js");
const licenseSource = path.join(root, "node_modules", "@twilio", "voice-sdk", "LICENSE.md");
const destinationDir = path.join(root, "RORC App", "vendor");
const destination = path.join(destinationDir, "twilio-voice.min.js");
const licenseDestination = path.join(destinationDir, "TWILIO-VOICE-LICENSE.md");

if (!fs.existsSync(source)) {
  throw new Error("Twilio Voice SDK is missing. Run npm install before building the app.");
}

fs.mkdirSync(destinationDir, { recursive: true });
fs.copyFileSync(source, destination);
fs.copyFileSync(licenseSource, licenseDestination);
console.log(`Copied Twilio Voice SDK to ${path.relative(root, destination)}.`);
