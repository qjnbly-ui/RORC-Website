function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeRentalHours(value, fallback = 1) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) return fallback;
  return Math.min(9, Math.max(0.01, Math.round(hours * 100) / 100));
}

function normalizeRentalBillableHours(value, fallback = 1) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) return fallback;
  return Math.min(24, Math.max(0.01, Math.round(hours * 100) / 100));
}

function rentalHoursLabel(value) {
  const hours = normalizeRentalHours(value);
  const label = String(Number(hours.toFixed(2)));
  return `${label} hr${hours === 1 ? "" : "s"}`;
}

function rentalBillableHoursLabel(value) {
  const hours = normalizeRentalBillableHours(value);
  const label = String(Number(hours.toFixed(2)));
  return `${label} hr${hours === 1 ? "" : "s"}`;
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

function formatRentalDate(value) {
  if (!value) return "TBD";
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric"
  }).format(date);
}

function formatRentalTime(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})/);
  if (!match) return String(value || "");
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return String(value || "");
  const date = new Date(2026, 0, 1, hours, minutes);
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function parseRentalTimeMinutes(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return (hours * 60) + minutes;
}

function rentalHoursBetween(startValue, endValue, fallback = 1) {
  const start = parseRentalTimeMinutes(startValue);
  const end = parseRentalTimeMinutes(endValue);
  if (start === null || end === null || end <= start) return fallback;
  return normalizeRentalBillableHours((end - start) / 60, fallback);
}

function calculateRentalTotal(record, includeCleaning = false) {
  const isPrivateEvent = record?.is_private_event !== false;
  let total;
  if (!isPrivateEvent) {
    total = Math.round(rentalHoursBetween(record?.event_start_time, record?.event_end_time, record?.rental_hours || 1) * 500);
  } else if (record?.rental_type === "hourly") {
    total = Math.round(normalizeRentalHours(record?.rental_hours || 1) * 1000);
  } else {
    total = 10000;
  }
  if (includeCleaning) total += 2000;
  if (record?.addon_tables) total += 2000;
  if (record?.addon_chairs) total += 2000;
  if (record?.addon_tarp) total += 2000;
  if (record?.addon_early_setup) total += 5000;
  if (record?.addon_early_day_rental) total += 10000;
  if (record?.addon_late_cleanup) total += 5000;
  if (record?.addon_late_day_rental) total += 10000;
  if (record?.special_access_discount) total = Math.round(total * 0.8);
  return total;
}

function rentalHasCleaningMaintenance(record) {
  if (typeof record?.addon_cleaning_maintenance === "boolean") return record.addon_cleaning_maintenance;
  const storedTotal = Number(record?.estimated_total_cents || 0);
  return Boolean(storedTotal && storedTotal >= calculateRentalTotal(record, true));
}

function rentalAddons(record) {
  return [
    rentalHasCleaningMaintenance(record) && "Standard Maintenance Fee",
    record?.addon_tables && "Tables",
    record?.addon_chairs && "Chairs",
    record?.addon_tarp && "Tarp",
    record?.addon_heater && "Heater Use",
    record?.addon_ac && "AC Use ($2/hr)",
    record?.addon_early_setup && "Early Setup",
    record?.addon_early_day_rental && "Extra Day (Early)",
    record?.addon_late_cleanup && "Late Cleanup",
    record?.addon_late_day_rental && "Extra Day (Late)"
  ].filter(Boolean);
}

function rentalDetailRows(record) {
  const rentalType = record?.is_private_event === false
    ? `Non-private (${rentalBillableHoursLabel(rentalHoursBetween(record?.event_start_time, record?.event_end_time, record?.rental_hours || 1))} @ $5/hr)`
    : record?.rental_type === "hourly"
      ? `By the Hour (${rentalHoursLabel(record?.rental_hours || 1)})`
      : "All Day";
  const start = formatRentalTime(record?.event_start_time);
  const end = formatRentalTime(record?.event_end_time);
  const addons = rentalAddons(record);
  const totalDollars = Number(record?.estimated_total_cents || 0) > 0
    ? (Number(record.estimated_total_cents) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
    : "TBD";

  return [
    ["Booking Number", record?.booking_number || record?.bookingNumber || "Pending"],
    ["Event Name", record?.event_name || "TBD"],
    ["Rental Category", record?.event_type || "TBD"],
    ["Date", formatRentalDate(record?.event_date)],
    ["Time", start && end ? `${start} - ${end}` : "TBD"],
    ["Rental Type", rentalType],
    ["Private Event", record?.is_private_event === false ? "No" : "Yes"],
    record?.special_access_discount ? ["Discount", "Special Access (20%)"] : null,
    ["Estimated Attendance", record?.estimated_attendance ? String(record.estimated_attendance) : "TBD"],
    ["Add-ons", addons.length ? addons.join(", ") : "None"],
    ["Estimated Total", totalDollars]
  ].filter(Boolean);
}

function buildRentalDetailsHtml(record) {
  return `
<div style="margin:22px 0;padding:16px;background:#151515;border:1px solid #333;border-radius:10px;">
  <p style="margin:0 0 12px;color:#fff;font-size:16px;font-weight:700;">Confirmed Booking Details</p>
  <table role="presentation" style="width:100%;border-collapse:collapse;color:#ddd;font-size:14px;">
    ${rentalDetailRows(record).map(([label, value]) => `
      <tr>
        <td style="padding:6px 10px 6px 0;color:#888;vertical-align:top;width:42%;">${escapeHtml(label)}</td>
        <td style="padding:6px 0;color:#f5f5f5;vertical-align:top;">${escapeHtml(value)}</td>
      </tr>
    `).join("")}
  </table>
</div>
<p style="margin:0 0 16px;color:#ccc;font-size:14px;">Please review the confirmed details above and contact RORC if anything looks incorrect.</p>`;
}

function buildRentalDetailsText(record) {
  return [
    "Confirmed Booking Details:",
    ...rentalDetailRows(record).map(([label, value]) => `${label}: ${value}`),
    "",
    "Please review the confirmed details above and contact RORC if anything looks incorrect."
  ].join("\n");
}

function buildRentalApplicantEmail({ record, status, adminNotes, manageUrl }) {
  const firstName = (record?.contact_name || "").split(" ")[0] || "there";
  const isConfirmed = status === "confirmed";
  const trimmedNotes = typeof adminNotes === "string" ? adminNotes.trim() : "";
  const detailsHtml = isConfirmed ? buildRentalDetailsHtml(record) : "";
  const detailsText = isConfirmed ? buildRentalDetailsText(record) : "";
  const bookingNumber = record?.booking_number || record?.bookingNumber || "";
  const manageLink = String(manageUrl || "").trim();
  const manageHtml = isConfirmed && manageLink
    ? `
<div style="margin:20px 0;padding:16px;background:#191919;border:1px solid #333;border-radius:10px;">
  <p style="margin:0 0 12px;color:#f5f5f5;font-size:15px;font-weight:700;">Manage this booking</p>
  <p style="margin:0 0 14px;color:#ccc;font-size:14px;line-height:1.55;">Use this secure link to create or connect a limited RORC rental account, view booking details, and request changes.</p>
  <p style="margin:0;">
    <a href="${escapeHtml(manageLink)}" style="display:inline-block;background:#f23a36;color:#fff;text-decoration:none;border-radius:999px;padding:12px 18px;font-weight:700;">Manage This Booking</a>
  </p>
  <p style="margin:12px 0 0;color:#888;font-size:12px;line-height:1.45;word-break:break-all;">If the button does not work, copy this link: ${escapeHtml(manageLink)}</p>
</div>`
    : "";

  const notesHtml = trimmedNotes
    ? `<p style="margin:16px 0 0;padding:14px 16px;background:#222;border-radius:8px;color:#ccc;font-size:14px;text-align:left;">${escapeHtml(trimmedNotes)}</p>`
    : "";

  const bodyHtml = isConfirmed
    ? `
<p style="margin:0 0 16px;color:#ccc;font-size:15px;">Hi ${escapeHtml(firstName)},</p>
<p style="margin:0 0 16px;color:#ccc;font-size:15px;">Great news — your rental request for a <strong style="color:#fff;">${escapeHtml(record?.event_type)}</strong> on <strong style="color:#fff;">${escapeHtml(record?.event_date)}</strong> has been <strong style="color:#fff;">confirmed</strong>.</p>
${bookingNumber ? `<p style="margin:0 0 16px;color:#ccc;font-size:15px;">Your booking number is <strong style="color:#fff;">${escapeHtml(bookingNumber)}</strong>.</p>` : ""}
<p style="margin:0 0 16px;color:#ccc;font-size:15px;">RORC staff will be in touch with next steps and payment details. If you have any questions, please reach out to us directly.</p>
${detailsHtml}
${manageHtml}
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
      bookingNumber ? `Booking number: ${bookingNumber}` : "",
      "RORC staff will be in touch with next steps and payment details. If you have any questions, please reach out to us directly.",
      detailsText,
      manageLink ? `Manage this booking: ${manageLink}` : "",
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
