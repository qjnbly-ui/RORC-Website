const {
  listSmsPreferences,
  requireAccountManager
} = require("./_staff-communications");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }

  try {
    await requireAccountManager(req);
    const result = await listSmsPreferences();
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Could not load text preferences."
    });
  }
};
