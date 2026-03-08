const { google } = require("googleapis");
const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

module.exports = async (req, res) => {

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {

    const { email } = req.body || {};

    if (!email) {
      return res.status(400).json({
        success: false,
        error: "Email required"
      });
    }

    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });

    const sheets = google.sheets({ version: "v4", auth });

    const spreadsheetId = "14ZMpY36GnDXXGplOJwzGZiUBlqv3F95E9ve-pwlLzYk";

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "Sheet1!A1:Q"
    });

    const rows = response.data.values || [];

    const headers = rows[0];
    const dataRows = rows.slice(1);

    const emailCol = headers.indexOf("Email Address");
    const passCol = headers.indexOf("Password");

    const normalizedEmail = email.trim().toLowerCase();

    let rowIndex = -1;

    for (let i = 0; i < dataRows.length; i++) {

      const rowEmail = String(dataRows[i][emailCol] || "")
        .trim()
        .toLowerCase();

      if (rowEmail === normalizedEmail) {
        rowIndex = i + 2;
        break;
      }

    }

    if (rowIndex === -1) {
      return res.json({
        success: true
      });
    }

    const newPin = Math.floor(1000 + Math.random() * 9000).toString();

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Sheet1!${String.fromCharCode(65 + passCol)}${rowIndex}`,
      valueInputOption: "RAW",
      requestBody: {
        values: [[newPin]]
      }
    });

    await resend.emails.send({

      from: "RORC Membership <members@ruthobenchainrc.com>",
      to: email,
      subject: "RORC Password Reset",

      html: `
        <h2>Ruth Obenchain Recreation Center</h2>

        <p>Your password has been reset.</p>

        <p><strong>Temporary PIN:</strong> ${newPin}</p>

        <p>You can now log in and change it from your member dashboard.</p>

        <p>If you did not request this reset, please contact us.</p>
      `
    });

    return res.json({
      success: true
    });

  } catch (error) {

    return res.status(500).json({
      success: false,
      error: "Server error",
      details: error.message
    });

  }

};