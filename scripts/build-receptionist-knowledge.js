const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = path.resolve(__dirname, "..");
const sources = [
  ["/", "index.html"],
  ["/about-rorc/", "about-rorc/index.html"],
  ["/memberships/", "memberships/index.html"],
  ["/membership-signup/", "membership-signup/index.html"],
  ["/rentals/", "rentals/index.html"],
  ["/events/", "events/index.html"],
  ["/news-updates/", "news-updates/index.html"],
  ["/projects/", "projects/index.html"],
  ["/sponsors/", "sponsors/index.html"],
  ["/work-exchange/", "work-exchange/index.html"],
  ["/windows/", "windows/index.html"],
  ["/support/", "support/index.html"],
  ["/privacy-policy/", "privacy-policy/index.html"],
  ["/terms-of-service/", "terms-of-service/index.html"],
];

function decode(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&ndash;|&#8211;/gi, "–")
    .replace(/&mdash;|&#8212;/gi, "—")
    .replace(/&copy;/gi, "©")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function visibleText(html) {
  return decode(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function chunks(text, max = 2800) {
  const sentences = text.match(/[^.!?]+(?:[.!?]+|$)/g) || [text];
  const result = [];
  let current = "";
  for (const sentence of sentences) {
    const clean = sentence.trim();
    if (!clean) continue;
    if (current && current.length + clean.length + 1 > max) {
      result.push(current);
      current = "";
    }
    current = `${current} ${clean}`.trim();
  }
  if (current) result.push(current);
  return result;
}

function buildKnowledge() {
  const pages = sources.flatMap(([route, file]) => {
    const html = fs.readFileSync(path.join(root, file), "utf8");
    const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || route);
    return chunks(visibleText(html)).map((text, index) => ({ route, title, index, text }));
  });
  const contentHash = crypto.createHash("sha256").update(JSON.stringify(pages)).digest("hex");
  return { contentHash, pages };
}

function serializedKnowledge() {
  return `${JSON.stringify(buildKnowledge(), null, 2)}\n`;
}

function run() {
  const destination = path.join(root, "api", "rorc-site-knowledge.json");
  const output = serializedKnowledge();
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(destination) ? fs.readFileSync(destination, "utf8") : "";
    if (current !== output) {
      console.error("RORC receptionist knowledge is out of date. Run npm run build:receptionist-knowledge.");
      process.exitCode = 1;
      return;
    }
    console.log("RORC receptionist knowledge is current.");
    return;
  }
  fs.writeFileSync(destination, output);
  console.log(`Built ${buildKnowledge().pages.length} RORC receptionist knowledge chunks.`);
}

if (require.main === module) run();

module.exports = { buildKnowledge, chunks, serializedKnowledge, visibleText };
