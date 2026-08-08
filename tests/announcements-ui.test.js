const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const appJs = fs.readFileSync(path.join(root, "RORC App", "app.js"), "utf8");
const appCss = fs.readFileSync(path.join(root, "RORC App", "app.css"), "utf8");
const immediateSender = fs.readFileSync(path.join(root, "api", "send-member-message.js"), "utf8");
const scheduledSender = fs.readFileSync(path.join(root, "api", "dispatch-scheduled-member-messages.js"), "utf8");
const {
  announcementMessageToPlainText,
  renderAnnouncementMessageHtml
} = require("../api/_announcement-formatting");

test("announcement sending is gated by a channel-by-channel approval dialog", () => {
  assert.match(appJs, /await showAnnouncementReviewDialog\(\{ title, message, memberIds, channels, sendAt \}\)/);
  assert.match(appJs, /if \(!confirmed\) \{/);
  assert.match(appJs, /data-announcement-preview-tab/);
  assert.match(appJs, /I reviewed this announcement\./);
  assert.match(appJs, /opted-out .* will be skipped for text delivery/);
});

test("text preferences are visible to staff and enforced by both announcement dispatch paths", () => {
  assert.match(appJs, /data-communications-tab="preferences"/);
  assert.match(appJs, /\/api\/sms-preferences/);
  assert.match(appJs, /They must reply START to receive future texts/);
  for (const source of [immediateSender, scheduledSender]) {
    assert.match(source, /optedOutPhoneSet/);
    assert.match(source, /skippedOptOutCount/);
  }
  assert.match(appCss, /\.sms-preferences-table-head,[\s\S]*?grid-template-columns:/);
  assert.match(appCss, /@media \(max-width: 520px\)[\s\S]*?\.sms-preferences-row/);
});

test("immediate and scheduled emails use the same structured formatter", () => {
  for (const source of [immediateSender, scheduledSender]) {
    assert.match(source, /renderAnnouncementMessageHtml/);
    assert.match(source, /announcementMessageToPlainText/);
  }
  assert.match(appJs, /announcementEmailPreviewHtml/);
  assert.match(appJs, /announcementMessageHtml/);
  assert.match(immediateSender, /createScheduledMemberMessage\(\{[\s\S]*?\n\s*message,\n/);
  assert.match(immediateSender, /createMessageHistoryRows\(\{[\s\S]*?message: plainMessage/);
  assert.match(scheduledSender, /message: plainMessage/);
});

test("announcement formatting produces real email blocks and clean text fallbacks", () => {
  const source = "Hello everyone,\n\n**Important update**\n\n- First **bold** item\n- Second item\n\n1. Read this\n2. *Reply* today\n\n<script>alert(1)</script>";
  const html = renderAnnouncementMessageHtml(source);
  const plain = announcementMessageToPlainText(source);

  assert.match(html, /<p[^>]*>Hello everyone,<\/p>/);
  assert.match(html, /<strong>Important update<\/strong>/);
  assert.match(html, /<ul[^>]*><li[^>]*>First <strong>bold<\/strong> item<\/li>/);
  assert.match(html, /<ol[^>]*><li[^>]*>Read this<\/li><li[^>]*><em>Reply<\/em> today<\/li><\/ol>/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(plain, /• First bold item/);
  assert.match(plain, /2\. Reply today/);
  assert.doesNotMatch(plain, /\*\*/);
});

test("composer stays compact and contains large recipient selections", () => {
  assert.doesNotMatch(appJs, /Write once\. Reach everyone\./);
  assert.doesNotMatch(appJs, /<span>0[1-4]<\/span>/);
  assert.match(appJs, /announcement-recipient-selection/);
  assert.match(appCss, /\.announcement-composer \.member-picker-button\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(appCss, /\.announcement-recipient-selection strong,[\s\S]*?text-overflow:\s*ellipsis/s);
});

test("announcement audience uses the branded searchable contact menu", () => {
  assert.match(appJs, /const useContactMenu = inputId === "messageMembers"/);
  assert.match(appJs, /placeholder="Search name, phone, or membership"/);
  assert.match(appJs, /renderMemberPickerOption\(member, selectedMemberIds\.has\(member\.id\), "checkbox", useContactMenu \? "contact" : "default"\)/);
  assert.match(appJs, /class="communications-contact-avatar"/);
  assert.match(appJs, /class="communications-contact-status"/);
  assert.match(appJs, /member\.phoneNumber \|\| member\.phone_number/);
  assert.match(appJs, /member-picker-selection-count/);
  assert.match(appCss, /\.member-picker-contact-dialog\s*\{/);
  assert.match(appCss, /\.member-picker-option\.member-picker-contact-option\s*\{/);
});

test("composer uses visible rich text and preserves formatting on paste", () => {
  assert.match(appJs, /class="announcement-rich-editor"[\s\S]*?contenteditable="true"/);
  assert.match(appJs, /function announcementEditorToMarkdown\(/);
  assert.match(appJs, /sanitizeAnnouncementEditorHtml\(richText\)/);
  assert.match(appJs, /announcementEditorHtmlFromMarkdown\(plainText\)/);
  assert.match(appJs, /document\.execCommand\(command, false, null\)/);
  assert.match(appJs, /document\.queryCommandState\(command\)/);
  assert.match(appCss, /\.announcement-format-toolbar button\.is-active/);
  assert.doesNotMatch(appJs, /<textarea id="messageBody"/);
});

test("nested editor formatting keeps paragraphs and lists intact in text and email", () => {
  const functionStart = appJs.indexOf("function announcementEditorToMarkdown(");
  const functionEnd = appJs.indexOf("\nconst ANNOUNCEMENT_FORMAT_COMMANDS", functionStart);
  const announcementEditorToMarkdown = vm.runInNewContext(
    `(${appJs.slice(functionStart, functionEnd)})`,
    { Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 } }
  );
  const text = (value) => ({ nodeType: 3, textContent: value });
  const element = (tagName, ...childNodes) => ({
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    childNodes,
    children: childNodes.filter((node) => node.nodeType === 1)
  });
  const editor = element("div",
    element("b",
      element("div", text("Hello,")),
      element("div", element("br")),
      element("ul",
        element("li", text("Test 1")),
        element("li", text("Test 2"))
      )
    ),
    element("div", element("i", text("Test three")))
  );

  const markdown = announcementEditorToMarkdown(editor);
  const plain = announcementMessageToPlainText(markdown);
  const html = renderAnnouncementMessageHtml(markdown);

  assert.equal(markdown, "**Hello,**\n\n- **Test 1**\n- **Test 2**\n\n*Test three*");
  assert.equal(plain, "Hello,\n\n• Test 1\n• Test 2\n\nTest three");
  assert.match(html, /<strong>Hello,<\/strong>/);
  assert.match(html, /<ul[^>]*><li[^>]*><strong>Test 1<\/strong><\/li><li[^>]*><strong>Test 2<\/strong><\/li><\/ul>/);
  assert.match(html, /<em>Test three<\/em>/);
  assert.doesNotMatch(plain, /\*\*/);
});

test("announcements provide wide, intermediate, and compact responsive layouts", () => {
  assert.match(appCss, /\.announcement-composer-grid\s*\{[^}]*grid-template-columns:\s*minmax\(340px, 0\.75fr\) minmax\(0, 1\.65fr\)/s);
  assert.match(appCss, /@media \(min-width: 981px\)[\s\S]*?\.announcement-delivery\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(appCss, /@media \(min-width: 981px\)[\s\S]*?\.announcement-rich-editor\s*\{[^}]*min-height:\s*0/s);
  assert.match(appCss, /@media \(max-width: 980px\)[\s\S]*?\.announcement-composer-grid\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(appCss, /@media \(max-width: 700px\)[\s\S]*?\.announcements-history-list > li/s);
});
