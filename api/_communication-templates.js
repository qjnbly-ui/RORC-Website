function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function buildEmailTemplate({ title, bodyHtml, bodyAlign = "center" }) {
  return `
    <div style="font-family:Arial,sans-serif;background:#111;color:#f5f5f5;padding:28px;line-height:1.55;text-align:center;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#1b1b1b;border:1px solid #333;border-radius:14px;overflow:hidden;text-align:center;">
        <tr>
          <td style="padding:28px 28px 16px;border-bottom:1px solid #333;text-align:center;">
            <h2 style="margin:0;color:#fff;font-size:32px;line-height:1.15;text-align:center;">${title}</h2>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 28px;text-align:${bodyAlign};">
            ${bodyHtml}
          </td>
        </tr>
        <tr>
          <td style="padding:24px 28px;border-top:1px solid #333;color:#888;font-size:13px;line-height:1.6;text-align:center;">
            <p style="margin:0 0 8px;text-align:center;">&copy; 2026 Ruth Obenchain Recreation Center</p>
            <p style="margin:0 0 8px;text-align:center;">
              <a href="https://ruthobenchainrc.com/support/" style="color:#bbb;text-decoration:none;">Support</a>
              &nbsp;|&nbsp;
              <a href="https://ruthobenchainrc.com/privacy-policy/" style="color:#bbb;text-decoration:none;">Privacy Policy</a>
              &nbsp;|&nbsp;
              <a href="https://ruthobenchainrc.com/terms-of-service/" style="color:#bbb;text-decoration:none;">Terms of Service</a>
            </p>
            <p style="margin:0;text-align:center;">Operated by Bly Community Action Team<br />Designed &amp; Built by N3XRA</p>
          </td>
        </tr>
      </table>
    </div>
  `;
}

function buildSignupReviewEmail({ contract, approved, notes }) {
  const trimmedNotes = String(notes || "").trim();
  const subject = approved ? "Your RORC account was approved" : "RORC account review update";
  const title = approved ? "RORC Account Approved" : "RORC Account Review";
  const bodyText = approved
    ? "Your RORC account has been approved. You can now use your RORC login for approved account access."
    : "Your RORC account was not approved at this time.";
  const text = [
    bodyText,
    trimmedNotes ? `Notes: ${trimmedNotes}` : "",
    "",
    "Open the member login: https://ruthobenchainrc.com/membership-login/"
  ].filter(Boolean).join("\n");

  const html = buildEmailTemplate({
    title: escapeHtml(title),
    bodyHtml: `
      <p style="margin:0 0 16px;color:#d1d5db;line-height:1.65;font-size:16px;text-align:center;">${escapeHtml(bodyText)}</p>
      ${trimmedNotes ? `<p style="margin:0 0 16px;color:#d1d5db;line-height:1.65;font-size:15px;text-align:center;"><strong>Notes:</strong> ${escapeHtml(trimmedNotes)}</p>` : ""}
      <p style="margin:0;text-align:center;">
        <a href="https://ruthobenchainrc.com/membership-login/" style="display:inline-block;background:#f23a36;color:#fff;text-decoration:none;border-radius:999px;padding:13px 22px;font-weight:700;">
          Open Member Login
        </a>
      </p>
    `
  });

  return {
    channel: "email",
    to: contract?.applicant_email || "",
    subject,
    text,
    html
  };
}

function buildRentalApplicantEmail({ record, status, adminNotes }) {
  const firstName = (record?.contact_name || "").split(" ")[0] || "there";
  const isConfirmed = status === "confirmed";
  const trimmedNotes = typeof adminNotes === "string" ? adminNotes.trim() : "";

  const notesHtml = trimmedNotes
    ? `<p style="margin:16px 0 0;padding:14px 16px;background:#222;border-radius:8px;color:#ccc;font-size:14px;text-align:left;">${escapeHtml(trimmedNotes)}</p>`
    : "";

  const bodyHtml = isConfirmed
    ? `
<p style="margin:0 0 16px;color:#ccc;font-size:15px;">Hi ${escapeHtml(firstName)},</p>
<p style="margin:0 0 16px;color:#ccc;font-size:15px;">Great news — your rental request for a <strong style="color:#fff;">${escapeHtml(record?.event_type)}</strong> on <strong style="color:#fff;">${escapeHtml(record?.event_date)}</strong> has been <strong style="color:#fff;">confirmed</strong>.</p>
<p style="margin:0 0 16px;color:#ccc;font-size:15px;">RORC staff will be in touch with next steps and payment details. If you have any questions, please reach out to us directly.</p>
${notesHtml}
<p style="margin:24px 0 0;color:#888;font-size:13px;">We look forward to hosting your event!</p>
`
    : `
<p style="margin:0 0 16px;color:#ccc;font-size:15px;">Hi ${escapeHtml(firstName)},</p>
<p style="margin:0 0 16px;color:#ccc;font-size:15px;">Thank you for submitting a rental request for a <strong style="color:#fff;">${escapeHtml(record?.event_type)}</strong> on <strong style="color:#fff;">${escapeHtml(record?.event_date)}</strong>.</p>
<p style="margin:0 0 16px;color:#ccc;font-size:15px;">Unfortunately, we are unable to accommodate your request at this time.</p>
${notesHtml}
<p style="margin:24px 0 0;color:#888;font-size:13px;">If you have questions, please contact RORC directly.</p>
`;

  const text = isConfirmed
    ? [
      `Hi ${firstName},`,
      "",
      `Great news — your rental request for a ${record?.event_type || "rental"} on ${record?.event_date || "the requested date"} has been confirmed.`,
      "RORC staff will be in touch with next steps and payment details. If you have any questions, please reach out to us directly.",
      trimmedNotes ? `Notes: ${trimmedNotes}` : "",
      "",
      "We look forward to hosting your event!"
    ].filter(Boolean).join("\n")
    : [
      `Hi ${firstName},`,
      "",
      `Thank you for submitting a rental request for a ${record?.event_type || "rental"} on ${record?.event_date || "the requested date"}.`,
      "Unfortunately, we are unable to accommodate your request at this time.",
      trimmedNotes ? `Notes: ${trimmedNotes}` : "",
      "",
      "If you have questions, please contact RORC directly."
    ].filter(Boolean).join("\n");

  return {
    channel: "email",
    to: record?.contact_email || "",
    subject: isConfirmed
      ? `Your Rental Request Has Been Confirmed — ${record?.event_date || "TBD"}`
      : "Update on Your RORC Rental Request",
    text,
    html: buildEmailTemplate({
      title: isConfirmed ? "Rental Confirmed" : "Rental Request Update",
      bodyHtml,
      bodyAlign: "left"
    })
  };
}

module.exports = {
  buildEmailTemplate,
  buildRentalApplicantEmail,
  buildSignupReviewEmail,
  escapeHtml
};
