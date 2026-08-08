function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatInline(value) {
  return escapeHtml(value)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
}

function renderAnnouncementMessageHtml(value) {
  const lines = String(value || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let listType = "";
  let listItems = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(`<p style="margin:0 0 16px;color:#d1d5db;line-height:1.65;font-size:16px;text-align:left;">${paragraph.map(formatInline).join("<br />")}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!listItems.length) return;
    const tag = listType === "ol" ? "ol" : "ul";
    blocks.push(`<${tag} style="margin:0 0 16px;padding-left:24px;color:#d1d5db;line-height:1.65;font-size:16px;text-align:left;">${listItems.map((item) => `<li style="margin:0 0 7px;padding-left:3px;">${formatInline(item)}</li>`).join("")}</${tag}>`);
    listType = "";
    listItems = [];
  };

  for (const line of lines) {
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const nextType = ordered ? "ol" : "ul";
      if (listType && listType !== nextType) flushList();
      listType = nextType;
      listItems.push((unordered || ordered)[1]);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return blocks.join("") || `<p style="margin:0;color:#d1d5db;line-height:1.65;font-size:16px;text-align:left;"></p>`;
}

function stripInlineFormatting(value) {
  return String(value || "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1");
}

function announcementMessageToPlainText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const unordered = line.match(/^\s*[-*]\s+(.+)$/);
      if (unordered) return `• ${stripInlineFormatting(unordered[1])}`;
      const ordered = line.match(/^(\s*\d+[.)]\s+)(.+)$/);
      if (ordered) return `${ordered[1]}${stripInlineFormatting(ordered[2])}`;
      return stripInlineFormatting(line);
    })
    .join("\n")
    .trim();
}

module.exports = {
  announcementMessageToPlainText,
  renderAnnouncementMessageHtml
};
