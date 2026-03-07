module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { login, pin } = req.body || {};

  console.log("Login attempt:", login, pin);

  return res.status(200).json({
    success: true,
    name: "Test Member"
  });
};