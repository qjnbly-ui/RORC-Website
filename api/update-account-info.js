module.exports = async (req, res) => {
  return res.status(410).json({
    success: false,
    error: "This legacy Google Sheet auth endpoint has been replaced by Supabase Auth."
  });
};
