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

const files = [
  [source, destination],
  [licenseSource, licenseDestination]
];

if (process.argv.includes("--check")) {
  const stale = files.filter(([sourcePath, destinationPath]) => (
    !fs.existsSync(destinationPath)
    || !fs.readFileSync(sourcePath).equals(fs.readFileSync(destinationPath))
  ));

  if (stale.length) {
    throw new Error("Twilio Voice browser assets are out of date. Run npm run build:twilio-voice.");
  }

  console.log("Twilio Voice browser assets match the installed SDK.");
} else {
  fs.mkdirSync(destinationDir, { recursive: true });
  files.forEach(([sourcePath, destinationPath]) => fs.copyFileSync(sourcePath, destinationPath));
  console.log(`Copied Twilio Voice SDK to ${path.relative(root, destination)}.`);
}
