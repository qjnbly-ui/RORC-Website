(function() {
  const container = document.getElementById("rentalClaimContent");
  if (!container) return;

  const token = new URLSearchParams(window.location.search).get("token") || "";
  let booking = null;

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function formatDate(value) {
    if (!value) return "TBD";
    const date = new Date(`${value}T12:00:00`);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  }

  function formatTimeRange(start, end) {
    if (!start || !end) return "TBD";
    return `${formatTime(start)} - ${formatTime(end)}`;
  }

  function formatTime(value) {
    const match = String(value || "").match(/^(\d{1,2}):(\d{2})/);
    if (!match) return value || "";
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const period = hour >= 12 ? "PM" : "AM";
    const h12 = hour % 12 || 12;
    return `${h12}:${String(minute).padStart(2, "0")} ${period}`;
  }

  function formatCurrency(cents) {
    const amount = Number(cents || 0) / 100;
    return amount > 0 ? amount.toLocaleString("en-US", { style: "currency", currency: "USD" }) : "TBD";
  }

  function setError(message) {
    container.innerHTML = `
      <h2 class="rorc-card-title">Unable To Claim Booking</h2>
      <p>${escapeHtml(message)}</p>
      <p><a href="/rentals/">Return to rentals</a></p>
    `;
  }

  function renderBookingForm() {
    if (!booking) return;
    if (booking.claimed) {
      container.innerHTML = `
        <h2 class="rorc-card-title">Booking Already Claimed</h2>
        ${bookingSummaryHtml()}
        <div class="rorc-actions" style="justify-content:flex-start;">
          <a class="rorc-btn rorc-btn-neutral" href="/membership-login/?email=${encodeURIComponent(booking.contactEmail || "")}">Log In</a>
          <a class="rorc-btn rorc-btn-gold" href="/member-dashboard/?booking=${encodeURIComponent(booking.bookingNumber || booking.id)}">Open Dashboard</a>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <h2 class="rorc-card-title">Set Up Rental Access</h2>
      ${bookingSummaryHtml()}
      <form id="rentalClaimForm" class="rorc-password-form">
        <label class="rorc-auth-label">
          <span>Email</span>
          <input class="rorc-auth-input" type="email" value="${escapeHtml(booking.contactEmail || "")}" readonly />
        </label>
        <label class="rorc-auth-label">
          <span>Create Password</span>
          <input id="rentalClaimPassword" class="rorc-auth-input" type="password" autocomplete="new-password" minlength="8" required />
        </label>
        <label class="rorc-auth-label">
          <span>Confirm Password</span>
          <input id="rentalClaimPasswordConfirm" class="rorc-auth-input" type="password" autocomplete="new-password" minlength="8" required />
        </label>
        <div class="rorc-actions" style="justify-content:flex-start;">
          <button id="rentalClaimSubmit" class="rorc-btn rorc-btn-gold" type="submit">Create Rental Account</button>
        </div>
        <p id="rentalClaimResult" class="rorc-card-text" style="min-height:1.5em;"></p>
      </form>
    `;

    document.getElementById("rentalClaimForm")?.addEventListener("submit", submitClaim);
  }

  function bookingSummaryHtml() {
    const publicWindow = booking.publicEventStartTime && booking.publicEventEndTime
      ? `<p><strong>Public Event Time:</strong> ${escapeHtml(formatTimeRange(booking.publicEventStartTime, booking.publicEventEndTime))}</p>`
      : "";
    return `
      <div class="rental-claim-summary">
        <p><strong>Booking Number:</strong> ${escapeHtml(booking.bookingNumber || "Pending")}</p>
        <p><strong>Event:</strong> ${escapeHtml(booking.eventName || booking.eventType || "Rental")}</p>
        <p><strong>Date:</strong> ${escapeHtml(formatDate(booking.eventDate))}</p>
        <p><strong>Rental Access:</strong> ${escapeHtml(formatTimeRange(booking.eventStartTime, booking.eventEndTime))}</p>
        ${publicWindow}
        <p><strong>Total:</strong> ${escapeHtml(formatCurrency(booking.estimatedTotalCents))}</p>
      </div>
    `;
  }

  async function submitClaim(event) {
    event.preventDefault();
    const result = document.getElementById("rentalClaimResult");
    const submit = document.getElementById("rentalClaimSubmit");
    const password = String(document.getElementById("rentalClaimPassword")?.value || "");
    const confirm = String(document.getElementById("rentalClaimPasswordConfirm")?.value || "");

    if (password.length < 8) {
      result.textContent = "Password must be at least 8 characters.";
      result.dataset.tone = "error";
      return;
    }
    if (password !== confirm) {
      result.textContent = "Passwords do not match.";
      result.dataset.tone = "error";
      return;
    }

    submit.disabled = true;
    submit.textContent = "Creating...";
    result.textContent = "Creating rental account...";
    result.dataset.tone = "default";

    try {
      const response = await fetch("/api/rental-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.success === false) {
        throw new Error(body.error || "Could not claim booking.");
      }

      if (body.reusedExistingAccount || body.alreadyClaimed) {
        result.textContent = "This booking is linked to your existing RORC account. Log in to view it.";
        result.dataset.tone = "success";
        window.location.href = body.loginUrl || "/membership-login/";
        return;
      }

      await signInAfterClaim(body.email || booking.contactEmail, password);
      window.location.href = body.dashboardUrl || "/member-dashboard/";
    } catch (error) {
      result.textContent = error.message || "Could not claim booking.";
      result.dataset.tone = "error";
      submit.disabled = false;
      submit.textContent = "Create Rental Account";
    }
  }

  async function signInAfterClaim(email, password) {
    if (!window.RORC_SUPABASE?.getClient) return false;
    const client = await window.RORC_SUPABASE.getClient();
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
      console.warn("Could not sign in rental claimant automatically.", error);
      return false;
    }
    return true;
  }

  async function init() {
    if (!token) {
      setError("Claim token is missing.");
      return;
    }
    try {
      const response = await fetch(`/api/rental-claim?token=${encodeURIComponent(token)}`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.success === false) {
        throw new Error(body.error || "Could not load this booking.");
      }
      booking = body.booking;
      renderBookingForm();
    } catch (error) {
      setError(error.message || "Could not load this booking.");
    }
  }

  init();
})();
