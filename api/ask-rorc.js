const { bearerToken } = require("./_automation-security");
const { answer } = require("../.build/receptionist/public-assistant");
const { fallbackIntent } = require("./_receptionist-router");

const supabaseUrl = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const recentRequests = new Map();

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: "Sign in to use Ask RORC." });

  const { question, history = [] } = req.body || {};
  if (typeof question !== "string" || !question.trim() || question.length > 800 ||
      !Array.isArray(history) || history.length > 8 ||
      history.some(item => !item || !["user", "assistant"].includes(item.role) ||
        typeof item.content !== "string" || item.content.length > 1500)) {
    return res.status(400).json({ error: "Enter a question of up to 800 characters." });
  }

  try {
    const session = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
        Authorization: `Bearer ${token}`
      },
      signal: AbortSignal.timeout(5000)
    });
    if ([401, 403].includes(session.status)) {
      return res.status(401).json({ error: "Your session expired. Sign in again." });
    }
    if (!session.ok) throw new Error("Session verification unavailable");
    const user = await session.json();
    if (!user?.id || user.is_anonymous) {
      return res.status(401).json({ error: "Sign in to use Ask RORC." });
    }

    // Limit bursts per warm instance before incurring a provider request.
    const now = Date.now();
    for (const [id, expires] of recentRequests) {
      if (expires <= now) recentRequests.delete(id);
    }
    if (recentRequests.has(user.id) || recentRequests.size >= 1000) {
      res.setHeader("Retry-After", "5");
      return res.status(429).json({ error: "Wait a few seconds before asking again." });
    }
    recentRequests.set(user.id, now + 5000);

    const text = question.trim();
    const route = fallbackIntent(text);
    const context = history.map(({ role, content }) => ({ role, content }));
    const reply = await answer(text, context, route.detail_level, route, { channel: "sms" });
    return res.status(200).json({ reply: reply.slice(0, 1500) });
  } catch {
    return res.status(503).json({ error: "Ask RORC is temporarily unavailable. Try again shortly." });
  }
};
