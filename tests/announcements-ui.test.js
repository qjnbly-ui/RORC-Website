const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const appJs = fs.readFileSync(path.join(root, "RORC App", "app.js"), "utf8");
const appCss = fs.readFileSync(path.join(root, "RORC App", "app.css"), "utf8");
const immediateSender = fs.readFileSync(path.join(root, "api", "send-member-message.js"), "utf8");
const scheduledSender = fs.readFileSync(path.join(root, "api", "dispatch-scheduled-member-messages.js"), "utf8");

test("announcement sending is gated by a channel-by-channel approval dialog", () => {
  assert.match(appJs, /await showAnnouncementReviewDialog\(\{ title, message, memberIds, channels, sendAt \}\)/);
  assert.match(appJs, /if \(!confirmed\) \{/);
  assert.match(appJs, /data-announcement-preview-tab/);
  assert.match(appJs, /I reviewed this announcement\./);
});

test("immediate and scheduled emails preserve plain-text spacing and line breaks", () => {
  for (const source of [immediateSender, scheduledSender]) {
    assert.match(source, /white-space:pre-wrap/);
    assert.match(source, /text-align:left/);
  }
  assert.match(appJs, /announcementEmailPreviewHtml/);
  assert.match(appJs, /white-space:pre-wrap/);
});

test("announcements provide wide, intermediate, and compact responsive layouts", () => {
  assert.match(appCss, /\.announcement-composer-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1\.65fr\)/s);
  assert.match(appCss, /@media \(max-width: 980px\)[\s\S]*?\.announcement-composer-grid\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(appCss, /@media \(max-width: 700px\)[\s\S]*?\.announcements-history-list > li/s);
});
