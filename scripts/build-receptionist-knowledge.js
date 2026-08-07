const fs = require("fs");
const path = require("path");

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

const pages = sources.flatMap(([route, file]) => {
  const html = fs.readFileSync(path.join(root, file), "utf8");
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || route);
  return chunks(visibleText(html)).map((text, index) => ({ route, title, index, text }));
});

fs.writeFileSync(path.join(root, "api", "rorc-site-knowledge.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), pages }, null, 2)}\n`);
console.log(`Built ${pages.length} RORC receptionist knowledge chunks.`);
