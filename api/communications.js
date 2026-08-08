const {
  listMessages,
  listThreads,
  markThreadRead,
  requireAccountManager,
  sendStaffMessage
} = require("./_staff-communications");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (!["GET", "POST", "PATCH"].includes(req.method)) {
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }

  try {
    const manager = await requireAccountManager(req);
    if (req.method === "GET") {
      const threadId = String(req.query?.threadId || "").trim();
      if (threadId) {
        return res.status(200).json({ success: true, messages: await listMessages(threadId) });
      }
      return res.status(200).json({ success: true, threads: await listThreads() });
    }

    if (req.method === "PATCH") {
      if (String(req.body?.action || "") !== "mark_read") {
        return res.status(400).json({ success: false, error: "Unsupported communications action." });
      }
      await markThreadRead(req.body?.threadId);
      return res.status(200).json({ success: true });
    }

    if (String(req.body?.action || "send_sms") !== "send_sms") {
      return res.status(400).json({ success: false, error: "Unsupported communications action." });
    }
    const result = await sendStaffMessage({
      to: req.body?.to,
      body: req.body?.body,
      managerId: manager.id,
      req
    });
    return res.status(201).json({ success: true, message: result });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Could not use staff communications."
    });
  }
};
