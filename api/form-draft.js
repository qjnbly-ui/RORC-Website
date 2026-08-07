const { getFormDraft } = require("./_rorc-form-drafts");
const { getFormDefinition } = require("./_rorc-forms");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed." });
  const token = String(req.body?.token || "").trim();
  const formId = String(req.body?.formId || "").trim().toLowerCase();
  if (!token || !getFormDefinition(formId)) return res.status(400).json({ success: false, error: "Invalid form draft request." });
  try {
    const draft = await getFormDraft(token, formId);
    if (!draft) return res.status(404).json({ success: false, error: "This draft link is invalid or has expired." });
    return res.status(200).json({ success: true, draft });
  } catch (error) {
    console.error("RORC form draft lookup failed", error);
    return res.status(500).json({ success: false, error: "Could not load this draft right now." });
  }
};
