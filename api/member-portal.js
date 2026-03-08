const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  try {
    const { member } = req.body || {};

    if (!member) {
      return res.status(400).json({
        success: false,
        error: "Missing member data"
      });
    }

    const customerId = String(member["StripeCustomerID"] || "").trim();

    if (!customerId) {
      return res.status(400).json({
        success: false,
        error: "No Stripe customer ID found for this account"
      });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: "https://www.ruthobenchainrc.com/member-dashboard/"
    });

    return res.status(200).json({
      success: true,
      url: session.url
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: "Server error",
      details: error.message
    });
  }
};