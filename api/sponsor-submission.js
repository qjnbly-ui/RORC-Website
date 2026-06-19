const SUPABASE_URL = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "RORC App <no-reply@ruthobenchainrc.com>";
const RORC_NOTIFY_EMAIL = process.env.RORC_NOTIFY_EMAIL || "quentin.nichols@ruthobenchainrc.com";
const { sendResendEmail } = require("./_resend");

const BUCKET_NAME = "sponsor-submissions";
const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_FILE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
  "application/pdf"
]);

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });
  if (!SERVICE_ROLE_KEY) return res.status(500).json({ success: false, error: "Server configuration error" });

  const body = req.body || {};
  const errors = validateSponsorSubmission(body);
  if (errors.length) {
    return res.status(400).json({ success: false, errors });
  }

  try {
    const sponsorshipType = normalizeSponsorshipType(body.sponsorshipType);
    const amountCents = sponsorshipType === "renewal" ? 10000 : 12500;
    const record = {
      sponsorship_type: sponsorshipType,
      amount_cents: amountCents,
      business_name: str(body.businessName),
      contact_name: str(body.contactName),
      email_address: str(body.emailAddress).toLowerCase(),
      phone_number: str(body.phoneNumber) || null,
      banner_text: str(body.bannerText) || null,
      design_requests: str(body.designRequests) || null,
      payment_method: normalizePaymentMethod(body.paymentMethod),
      price_acknowledged: body.priceAcknowledged === true,
      logo_files: []
    };

    const insertedRows = await supabaseWrite("sponsor_banner_submissions", "POST", record);
    const saved = insertedRows[0];
    if (!saved?.id) throw new Error("Submission was not saved");

    const uploadedFiles = [];
    for (const file of normalizedFiles(body.logoFiles)) {
      uploadedFiles.push(await uploadSponsorFile(saved.id, file));
    }

    if (uploadedFiles.length) {
      await supabaseWrite(
        `sponsor_banner_submissions?id=eq.${encodeURIComponent(saved.id)}`,
        "PATCH",
        { logo_files: uploadedFiles }
      );
    }

    await sendSponsorNotification({ ...saved, ...record, logo_files: uploadedFiles }).catch((error) => {
      console.error("Sponsor notification email failed:", error);
    });

    return res.status(200).json({ success: true, id: saved.id });
  } catch (error) {
    console.error("sponsor-submission error:", error);
    return res.status(500).json({
      success: false,
      error: "Could not submit sponsor information. Please try again or contact RORC directly."
    });
  }
};

function validateSponsorSubmission(body) {
  const errors = [];
  if (!["new", "renewal"].includes(normalizeSponsorshipType(body.sponsorshipType))) {
    errors.push("Select new sponsorship or renewal.");
  }
  if (!str(body.businessName)) errors.push("Business / sponsor name is required.");
  if (!str(body.contactName)) errors.push("Contact name is required.");
  if (!isEmail(body.emailAddress)) errors.push("A valid email address is required.");
  if (!["mail_check", "stripe_invoice"].includes(normalizePaymentMethod(body.paymentMethod))) {
    errors.push("Select how you would like to pay.");
  }
  if (body.priceAcknowledged !== true) {
    errors.push("Please acknowledge the banner sponsorship pricing.");
  }

  const files = normalizedFiles(body.logoFiles);
  if (files.length > MAX_FILES) errors.push(`Upload no more than ${MAX_FILES} files.`);
  files.forEach((file) => {
    if (!file.name || !file.dataBase64) {
      errors.push("Each uploaded file must include a name and file data.");
      return;
    }
    if (!ALLOWED_FILE_TYPES.has(file.contentType)) {
      errors.push(`${file.name} must be a PNG, JPG, WebP, SVG, or PDF file.`);
    }
    if (decodedBase64Size(file.dataBase64) > MAX_FILE_BYTES) {
      errors.push(`${file.name} must be 10 MB or smaller.`);
    }
  });

  return errors;
}

async function uploadSponsorFile(submissionId, file) {
  const buffer = Buffer.from(file.dataBase64, "base64");
  const safeName = safeFileName(file.name);
  const path = `${submissionId}/${Date.now()}-${safeName}`;
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET_NAME}/${encodeStoragePath(path)}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": file.contentType,
      "x-upsert": "false"
    },
    body: buffer
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Sponsor file upload failed: ${response.status} ${text}`);
  }
  return {
    bucket: BUCKET_NAME,
    path,
    name: file.name,
    contentType: file.contentType,
    size: buffer.length
  };
}

async function sendSponsorNotification(record) {
  if (!RESEND_API_KEY || !RORC_NOTIFY_EMAIL) return;
  const sponsorshipLabel = record.sponsorship_type === "renewal" ? "Renewal" : "New Sponsorship";
  const paymentLabel = record.payment_method === "stripe_invoice" ? "Digital invoice through Stripe" : "Mail a check";
  const amountLabel = formatCurrency(record.amount_cents);
  const fileLines = (record.logo_files || []).map((file) => `- ${file.name} (${file.contentType}, ${Math.round((file.size || 0) / 1024)} KB)`);
  const text = [
    "New RORC Banner Sponsor Submission",
    `Submitted: ${new Date().toISOString()}`,
    `Type: ${sponsorshipLabel}`,
    `Amount: ${amountLabel}`,
    `Business / Sponsor: ${record.business_name}`,
    `Contact: ${record.contact_name}`,
    `Email: ${record.email_address}`,
    `Phone: ${record.phone_number || "(none)"}`,
    `Payment: ${paymentLabel}`,
    "",
    "Banner Text:",
    record.banner_text || "(none)",
    "",
    "Design Requests:",
    record.design_requests || "(none)",
    "",
    "Files:",
    fileLines.length ? fileLines.join("\n") : "(none)"
  ].join("\n");

  const html = `
    <div style="font-family:Arial,sans-serif;background:#111;color:#f5f5f5;padding:24px;">
      <div style="max-width:680px;margin:0 auto;background:#1b1b1b;border:1px solid #333;border-radius:14px;padding:24px;">
        <h2 style="margin:0 0 16px;">New Banner Sponsor Submission</h2>
        <p><strong>Type:</strong> ${escapeHtml(sponsorshipLabel)}</p>
        <p><strong>Amount:</strong> ${escapeHtml(amountLabel)}</p>
        <p><strong>Business / Sponsor:</strong> ${escapeHtml(record.business_name)}</p>
        <p><strong>Contact:</strong> ${escapeHtml(record.contact_name)}</p>
        <p><strong>Email:</strong> ${escapeHtml(record.email_address)}</p>
        <p><strong>Phone:</strong> ${escapeHtml(record.phone_number || "(none)")}</p>
        <p><strong>Payment:</strong> ${escapeHtml(paymentLabel)}</p>
        <p><strong>Banner Text:</strong><br>${escapeHtml(record.banner_text || "(none)")}</p>
        <p><strong>Design Requests:</strong><br>${escapeHtml(record.design_requests || "(none)")}</p>
        <p><strong>Files:</strong><br>${escapeHtml(fileLines.length ? fileLines.join("\n") : "(none)")}</p>
      </div>
    </div>
  `;

  await sendResendEmail({
    apiKey: RESEND_API_KEY,
    from: RESEND_FROM_EMAIL,
    to: [RORC_NOTIFY_EMAIL],
    replyTo: record.email_address ? [record.email_address] : undefined,
    subject: `[RORC Sponsor] ${record.business_name} - ${sponsorshipLabel}`,
    text,
    html,
    idempotencyKey: `sponsor-submission-${record.id}`
  });
}

async function supabaseWrite(path, method, payload) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`REST write failed: ${response.status} ${text}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : [];
}

function normalizedFiles(value) {
  return Array.isArray(value)
    ? value.map((file) => ({
      name: str(file?.name),
      contentType: str(file?.contentType || file?.type).toLowerCase(),
      dataBase64: normalizeBase64(file?.dataBase64 || "")
    })).filter((file) => file.name || file.dataBase64)
    : [];
}

function normalizeSponsorshipType(value) {
  const normalized = str(value).toLowerCase();
  return normalized === "renewal" ? "renewal" : normalized === "new" ? "new" : "";
}

function normalizePaymentMethod(value) {
  const normalized = str(value).toLowerCase();
  return normalized === "stripe_invoice" ? "stripe_invoice" : normalized === "mail_check" ? "mail_check" : "";
}

function normalizeBase64(value) {
  return String(value || "").replace(/^data:[^;]+;base64,/, "").replace(/\s/g, "");
}

function decodedBase64Size(value) {
  const clean = normalizeBase64(value);
  if (!clean) return 0;
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

function encodeStoragePath(path) {
  return String(path).split("/").map(encodeURIComponent).join("/");
}

function safeFileName(value) {
  return str(value).replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "upload";
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str(value));
}

function formatCurrency(cents) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(Number(cents || 0) / 100);
}

function str(value) {
  return String(value || "").trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
