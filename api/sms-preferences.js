const { getSmsBookingSettings, setSmsBookingEnabled } = require('./_sms-booking-settings');
const {
  listSmsPreferences,
  requireAccountManager
} = require("./_staff-communications");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (!["GET", "PATCH"].includes(req.method)) {
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }

  try {
    const manager = await requireAccountManager(req);
    if (req.method === "PATCH") {
      if (req.body?.action !== "set_booking_ai") return res.status(400).json({ success: false, error: "Unsupported text preference action." });
      const bookingAi = await setSmsBookingEnabled(req.body.enabled, manager.id);
      return res.status(200).json({ success: true, bookingAi });
    }
    const bookingAi = await getSmsBookingSettings();
    const result = await listSmsPreferences();
    return res.status(200).json({ success: true, ...result, bookingAi });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Could not load text preferences."
    });
  }
};
