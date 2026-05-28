(function() {
  const LOGIN_PATH = "/membership-login/";
  const STRIPE_FALLBACK_PORTAL = "https://payments.ruthobenchainrc.com/p/login/eVaeWh2tN0vxgSs288";
  const ACCOUNT_TYPE_OPTIONS = [
    "Account Manager",
    "Kiosk Account",
    "Special Access Account",
    "Active Membership",
    "Weight Room Only",
    "Open Gym Only",
    "RESTRICTED ACCOUNT"
  ];

  let supabaseClient = null;
  let currentSession = null;
  let currentProfile = null;
  let currentAccountBilling = null;
  let visibleProfiles = [];
  let recoveryMode = false;

  function byId(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return window.CSS.escape(String(value || ""));
    return String(value || "").replace(/["\\]/g, "\\$&");
  }

  function formatDate(value) {
    if (!value) return "Not set";

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);

    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric"
    });
  }

  function profileValue(value, fallback = "Not set") {
    return value ? escapeHtml(value) : fallback;
  }

  function setMessage(element, message, tone = "default") {
    if (!element) return;
    element.textContent = message;
    element.dataset.tone = tone;
  }

  function isAccountManager(profile) {
    return profile?.account_type === "Account Manager";
  }

  function canUseAccountAdminTools(profile = currentProfile) {
    return isAccountManager(profile);
  }

  function isRentalAccount(profile) {
    return profile?.account_type === "Rental Account";
  }

  function canManageBilling(profile) {
    if (isRentalAccount(profile)) return false;
    return Boolean(profile?.is_billing_owner || isAccountManager(profile));
  }

  function formatTime(value) {
    const match = String(value || "").match(/^(\d{1,2}):(\d{2})/);
    if (!match) return value || "Not set";
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const period = hour >= 12 ? "PM" : "AM";
    const h12 = hour % 12 || 12;
    return `${h12}:${String(minute).padStart(2, "0")} ${period}`;
  }

  function formatTimeRange(start, end) {
    if (!start || !end) return "Not set";
    return `${formatTime(start)} - ${formatTime(end)}`;
  }

  function normalizeDateInput(value) {
    if (!value) return "";
    const text = String(value);
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) return "";
    return date.toISOString().slice(0, 10);
  }

  function sameAccountProfiles() {
    if (!currentProfile?.account_id) return [];
    return (visibleProfiles || [])
      .filter((profile) => profile.account_id === currentProfile.account_id)
      .sort((a, b) => String(a.member_name || "").localeCompare(String(b.member_name || ""), undefined, { sensitivity: "base" }));
  }

  function setElementsHidden(selector, hidden) {
    document.querySelectorAll(selector).forEach((element) => {
      element.hidden = Boolean(hidden);
    });
  }

  function setSelectValue(select, value) {
    if (!select) return;
    select.value = value;
    if (select.value !== value && value) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
      select.value = value;
    }
  }

  function formatCurrency(cents) {
    const amount = Number(cents || 0) / 100;
    return amount > 0 ? amount.toLocaleString("en-US", { style: "currency", currency: "USD" }) : "TBD";
  }

  async function syncStripeMembershipIfAllowed() {
    if (!currentSession || !canManageBilling(currentProfile)) {
      return false;
    }

    try {
      const response = await fetch("/api/sync-stripe-membership", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${currentSession.access_token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          accountId: currentProfile.account_id
        })
      });

      const payload = await response.json().catch(() => ({}));
      if (response.status === 403 || response.status === 404) {
        return false;
      }

      if (!response.ok || payload.success === false) {
        console.warn("Stripe membership sync failed.", payload.error || response.status);
        return false;
      }

      return true;
    } catch (error) {
      console.warn("Stripe membership sync failed.", error);
      return false;
    }
  }

  async function loadCurrentAccountBilling() {
    currentAccountBilling = null;

    if (!supabaseClient || !currentProfile?.account_id) {
      return null;
    }

    try {
      const { data, error } = await supabaseClient
        .from("account_billing")
        .select("stripe_customer_id,billing_status,stripe_status,current_period_end,last_sync")
        .eq("account_id", currentProfile.account_id)
        .maybeSingle();

      if (error) {
        console.warn("Account billing details unavailable.", error.message || error);
        return null;
      }

      currentAccountBilling = data || null;
      return currentAccountBilling;
    } catch (error) {
      console.warn("Account billing details unavailable.", error);
      return null;
    }
  }

  function openPasswordModal(message = "") {
    const modal = byId("updatePasswordModal");
    const result = byId("passwordResult");

    if (!modal) return;

    setMessage(result, message);
    modal.hidden = false;
    byId("newPassword")?.focus();
  }

  async function loadSessionAndProfile() {
    if (!window.RORC_SUPABASE) {
      throw new Error("Supabase is not configured on this page.");
    }

    supabaseClient = await window.RORC_SUPABASE.getClient();
    recoveryMode = Boolean(window.RORC_SUPABASE.isRecoveryLink?.());

    window.RORC_SUPABASE.onAuthEvent?.((event) => {
      if (event !== "PASSWORD_RECOVERY") return;
      recoveryMode = true;
      openPasswordModal("Enter a new password to finish resetting your RORC login.");
    });

    const result = await window.RORC_SUPABASE.getCurrentMemberProfile();

    if (!result.session) {
      const params = new URLSearchParams(window.location.search);
      const signupStatus = params.get("signup");
      window.location.href = signupStatus
        ? `${LOGIN_PATH}?signup=${encodeURIComponent(signupStatus)}`
        : LOGIN_PATH;
      return false;
    }

    if (!result.profile) {
      throw new Error("Your login is valid, but no linked member profile was found.");
    }

    currentSession = result.session;
    currentProfile = result.profile;
    visibleProfiles = result.profiles || [];

    if (await syncStripeMembershipIfAllowed()) {
      const refreshed = await window.RORC_SUPABASE.getCurrentMemberProfile();
      currentSession = refreshed.session;
      currentProfile = refreshed.profile;
      visibleProfiles = refreshed.profiles || [];
    }

    await loadCurrentAccountBilling();

    return true;
  }

  function renderDashboard() {
    const container = byId("memberDashboard");
    if (!container || !currentProfile) return;

    const signupStatus = new URLSearchParams(window.location.search).get("signup");
    const sameAccountMembers = visibleProfiles
      .filter((profile) => profile.account_id === currentProfile.account_id)
      .map((profile) => profile.member_name)
      .filter(Boolean);

    container.innerHTML = `
      ${signupStatus === "pending_review" ? `
        <p><strong>Signup received:</strong> your account is pending RORC admin approval before facility access is enabled.</p>
      ` : ""}
      <h3>Welcome, ${escapeHtml(currentProfile.member_name)}</h3>
      <p><strong>Account Type:</strong> ${profileValue(currentProfile.account_type)}</p>
      <p><strong>Account Number:</strong> ${profileValue(currentProfile.account_number)}</p>
      <p><strong>Billing Status:</strong> ${profileValue(currentProfile.billing_status || currentProfile.stripe_status, "None")}</p>
      <p><strong>Current Period End:</strong> ${escapeHtml(formatDate(currentProfile.current_period_end))}</p>
      <p><strong>Email:</strong> ${profileValue(currentProfile.email_address)}</p>
      <p><strong>Phone:</strong> ${profileValue(currentProfile.phone_number)}</p>
      ${sameAccountMembers.length > 1 ? `
        <p><strong>Users On This Account:</strong> ${escapeHtml(sameAccountMembers.join(", "))}</p>
      ` : ""}
    `;
  }

  function revealPrivateAppCard() {
    const appCard = byId("rorcAppCard");
    if (appCard) {
      appCard.hidden = false;
      if (isRentalAccount(currentProfile)) {
        const copy = appCard.querySelector(".rorc-card-text");
        if (copy) {
          copy.textContent = "Open the RORC app to view the calendar, about page, and My Events for your rental booking.";
        }
        const installBtn = byId("installRorcAppBtn");
        if (installBtn) installBtn.textContent = "Open App";
      }
    }
  }

  function hydrateAccountForm() {
    const canUseAdminTools = canUseAccountAdminTools();
    const isRental = isRentalAccount(currentProfile);
    const accountMemberName = byId("accountMemberName");
    const accountPhone = byId("accountPhone");
    const accountEmail = byId("accountEmail");
    const accountHeaterPin = byId("accountHeaterPin");
    const accountNumber = byId("accountNumber");
    const accountType = byId("accountType");
    const accountAllowGuestEntry = byId("accountAllowGuestEntry");
    const accountAllowHeaterUse = byId("accountAllowHeaterUse");
    const accountDateOfBirth = byId("accountDateOfBirth");
    const accountGuardianMemberId = byId("accountGuardianMemberId");
    const accountCanAccessIndependently = byId("accountCanAccessIndependently");
    const accountStripeCustomerId = byId("accountStripeCustomerId");
    const accountInfoPermissionNote = byId("accountInfoPermissionNote");

    setElementsHidden("[data-account-admin-only]", !canUseAdminTools);
    setElementsHidden("[data-account-non-rental-only]", isRental);

    if (accountInfoPermissionNote) {
      accountInfoPermissionNote.textContent = canUseAdminTools
        ? "Account Manager access is active, so this matches the app member editor for this profile and shared account."
        : "You can edit your contact information and shared account heater PIN. Account control fields are only editable by Account Managers, same as the app.";
    }

    if (accountMemberName) {
      accountMemberName.value = currentProfile?.member_name || "";
      accountMemberName.disabled = !canUseAdminTools;
    }

    if (accountPhone) {
      accountPhone.value = currentProfile?.phone_number || "";
    }

    if (accountEmail) {
      accountEmail.value = currentProfile?.email_address || currentSession?.user?.email || "";
    }

    if (accountHeaterPin) {
      accountHeaterPin.value = currentProfile?.heater_pin || "";
      accountHeaterPin.dataset.originalValue = currentProfile?.heater_pin || "";
    }

    if (!canUseAdminTools) {
      return;
    }

    if (accountNumber) {
      accountNumber.value = currentProfile?.account_number || "";
      accountNumber.dataset.originalValue = currentProfile?.account_number || "";
    }

    if (accountType) {
      accountType.innerHTML = ACCOUNT_TYPE_OPTIONS.map((option) => `
        <option value="${escapeHtml(option)}">${escapeHtml(option)}</option>
      `).join("");
      setSelectValue(accountType, currentProfile?.account_type || "");
    }

    if (accountAllowGuestEntry) {
      accountAllowGuestEntry.value = currentProfile?.allow_guest_entry ? "yes" : "no";
    }

    if (accountAllowHeaterUse) {
      accountAllowHeaterUse.value = currentProfile?.allow_heater_use ? "yes" : "no";
    }

    if (accountDateOfBirth) {
      accountDateOfBirth.value = normalizeDateInput(currentProfile?.date_of_birth);
    }

    if (accountGuardianMemberId) {
      const currentMemberId = currentProfile?.account_member_id || "";
      const guardianOptions = sameAccountProfiles()
        .filter((profile) => profile.account_member_id !== currentMemberId)
        .map((profile) => `
          <option value="${escapeHtml(profile.account_member_id)}">${escapeHtml(profile.member_name || "Unnamed Member")}</option>
        `)
        .join("");

      accountGuardianMemberId.innerHTML = `
        <option value="">No guardian linked</option>
        ${guardianOptions}
      `;
      setSelectValue(accountGuardianMemberId, currentProfile?.guardian_member_id || "");
    }

    if (accountCanAccessIndependently) {
      accountCanAccessIndependently.value = currentProfile?.can_access_independently === false ? "no" : "yes";
    }

    if (accountStripeCustomerId) {
      const stripeCustomerId = currentAccountBilling?.stripe_customer_id || currentProfile?.stripe_customer_id || "";
      accountStripeCustomerId.value = stripeCustomerId;
      accountStripeCustomerId.dataset.originalValue = stripeCustomerId;
    }
  }

  function clearInviteForm() {
    ["inviteMemberName", "inviteMemberEmail", "inviteMemberDob", "inviteMemberPhone"].forEach((id) => {
      const input = byId(id);
      if (input) input.value = "";
    });
  }

  function isUnder13(dateOfBirth) {
    const birth = new Date(`${dateOfBirth}T00:00:00Z`);
    if (Number.isNaN(birth.getTime())) return false;

    const today = new Date();
    const thirteenthBirthday = new Date(Date.UTC(birth.getUTCFullYear() + 13, birth.getUTCMonth(), birth.getUTCDate()));
    return today.getTime() < thirteenthBirthday.getTime();
  }

  function configureBillingButton() {
    const billingButton = byId("billingBtn");
    if (!billingButton || !currentProfile) return;

    if (isRentalAccount(currentProfile)) {
      billingButton.textContent = "Upgrade To Membership";
      billingButton.disabled = false;
      billingButton.addEventListener("click", () => {
        window.location.href = "/membership-signup/?upgrade=rental";
      });
      return;
    }

    if (!canManageBilling(currentProfile)) {
      billingButton.textContent = "Billing Managed By Account Owner";
      billingButton.disabled = true;
      return;
    }

    billingButton.textContent = "Manage Billing";
    billingButton.disabled = false;

    billingButton.addEventListener("click", async () => {
      const originalText = billingButton.textContent;
      billingButton.disabled = true;
      billingButton.textContent = "Opening...";

      try {
        const { data } = await supabaseClient.auth.getSession();
        const token = data.session?.access_token;

        if (!token) {
          window.location.href = LOGIN_PATH;
          return;
        }

        const response = await fetch("/api/member-portal", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            accountId: currentProfile.account_id,
            returnPath: "/member-dashboard/"
          })
        });

        const payload = await response.json();

        if (response.ok && payload.success && payload.url) {
          window.location.href = payload.url;
          return;
        }

        if (response.status === 404) {
          window.open(STRIPE_FALLBACK_PORTAL, "_blank", "noopener");
          return;
        }

        throw new Error(payload.error || "Could not open billing portal.");
      } catch (error) {
        window.alert(error.message || "Could not open billing portal.");
      } finally {
        billingButton.disabled = false;
        billingButton.textContent = originalText;
      }
    });
  }

  function bindAccountInvite() {
    const card = byId("accountInviteCard");
    const inviteButton = byId("inviteAccountUserBtn");
    const result = byId("inviteAccountResult");

    if (!card || !inviteButton || !currentProfile) return;

    if (!canManageBilling(currentProfile) || isRentalAccount(currentProfile)) {
      card.hidden = true;
      return;
    }

    card.hidden = false;

    inviteButton.addEventListener("click", async () => {
      const memberName = String(byId("inviteMemberName")?.value || "").trim();
      const email = String(byId("inviteMemberEmail")?.value || "").trim().toLowerCase();
      const dateOfBirth = String(byId("inviteMemberDob")?.value || "").trim();
      const phoneNumber = String(byId("inviteMemberPhone")?.value || "").trim();

      if (!dateOfBirth) {
        setMessage(result, "Date of birth is required.", "error");
        return;
      }

      if (!email && !phoneNumber && !isUnder13(dateOfBirth)) {
        setMessage(result, "Email or phone number is required for anyone 13 or older.", "error");
        return;
      }

      if (!email && !memberName) {
        setMessage(result, "Name is required for under-13 users without an email.", "error");
        return;
      }

      inviteButton.disabled = true;
      setMessage(result, "Adding user to your account...");

      try {
        const { data } = await supabaseClient.auth.getSession();
        const token = data.session?.access_token;

        if (!token) {
          window.location.href = LOGIN_PATH;
          return;
        }

        const response = await fetch("/api/account-invite", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            memberName,
            email,
            dateOfBirth,
            phoneNumber
          })
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.success === false) {
          throw new Error(payload.error || "Could not invite account user.");
        }

        clearInviteForm();
        await refreshProfile();
        const deliveryErrors = Array.isArray(payload.deliveryErrors) && payload.deliveryErrors.length
          ? ` Delivery issue: ${payload.deliveryErrors.join(" ")}`
          : "";
        setMessage(result, payload.inviteUrl
          ? `${payload.message || "Contract invite created."} ${payload.inviteUrl}`
          : payload.message || "User added.",
          "success"
        );
        if (deliveryErrors) {
          result.textContent = `${result.textContent}${deliveryErrors}`;
        }
      } catch (error) {
        setMessage(result, error.message || "Could not invite account user.", "error");
      } finally {
        inviteButton.disabled = false;
      }
    });
  }

  async function refreshProfile() {
    const result = await window.RORC_SUPABASE.getCurrentMemberProfile();
    currentSession = result.session;
    currentProfile = result.profile;
    visibleProfiles = result.profiles || [];
    await loadCurrentAccountBilling();
    renderDashboard();
    hydrateAccountForm();
    loadRentalBookings();
  }

  async function postAuthenticatedJson(path, payload) {
    const { data } = await supabaseClient.auth.getSession();
    const token = data.session?.access_token || currentSession?.access_token || "";

    if (!token) {
      window.location.href = LOGIN_PATH;
      return null;
    }

    const response = await fetch(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => ({}));

    if (!response.ok || body.success === false) {
      throw new Error(body.error || `Request failed (${response.status}).`);
    }

    return body;
  }

  async function updateSharedHeaterPin(accountId, heaterPin) {
    return postAuthenticatedJson("/api/update-account-heater-pin", {
      accountId,
      heaterPin: heaterPin || null
    });
  }

  async function updateAccountStripeCustomerId(accountId, stripeCustomerId) {
    return postAuthenticatedJson("/api/update-account-billing", {
      accountId,
      stripeCustomerId: stripeCustomerId || null
    });
  }

  async function moveCurrentMemberToAccount(targetAccountNumber) {
    return postAuthenticatedJson("/api/move-member-account", {
      memberId: currentProfile.account_member_id,
      targetAccountNumber
    });
  }

  function bindAccountInfoModal() {
    const openButton = byId("openAccountInfoBtn");
    const modal = byId("accountInfoModal");
    const updateButton = byId("updateAccountBtn");
    const result = byId("accountResult");

    if (!openButton || !modal || !updateButton) return;

    openButton.addEventListener("click", async () => {
      hydrateAccountForm();
      setMessage(result, "");
      modal.hidden = false;

      if (canUseAccountAdminTools()) {
        setMessage(result, "Loading account details...");
        await loadCurrentAccountBilling();
        hydrateAccountForm();
        setMessage(result, "");
      }

      (byId("accountMemberName") || byId("accountPhone"))?.focus();
    });

    modal.addEventListener("click", (event) => {
      if (event.target && event.target.hasAttribute("data-close")) {
        modal.hidden = true;
      }
    });

    updateButton.addEventListener("click", async () => {
      const canUseAdminTools = canUseAccountAdminTools();
      const memberName = String(byId("accountMemberName")?.value || currentProfile?.member_name || "").trim();
      const phone = String(byId("accountPhone")?.value || "").trim();
      const email = String(byId("accountEmail")?.value || "").trim().toLowerCase();
      const heaterPin = String(byId("accountHeaterPin")?.value || "").trim();
      const originalHeaterPin = String(byId("accountHeaterPin")?.dataset.originalValue || "").trim();
      const accountNumber = String(byId("accountNumber")?.value || currentProfile?.account_number || "").trim();
      const originalAccountNumber = String(byId("accountNumber")?.dataset.originalValue || currentProfile?.account_number || "").trim();
      const accountType = String(byId("accountType")?.value || currentProfile?.account_type || "").trim();
      const allowGuestEntry = String(byId("accountAllowGuestEntry")?.value || "no") === "yes";
      const allowHeaterUse = String(byId("accountAllowHeaterUse")?.value || "no") === "yes";
      const dateOfBirth = String(byId("accountDateOfBirth")?.value || "").trim();
      const guardianMemberId = String(byId("accountGuardianMemberId")?.value || "").trim();
      const canAccessIndependently = String(byId("accountCanAccessIndependently")?.value || "yes") === "yes";
      const stripeCustomerId = String(byId("accountStripeCustomerId")?.value || "").trim();
      const originalStripeCustomerId = String(byId("accountStripeCustomerId")?.dataset.originalValue || "").trim();

      if (!email) {
        setMessage(result, "Email address is required.", "error");
        return;
      }

      if (canUseAdminTools && !memberName) {
        setMessage(result, "Member name is required.", "error");
        return;
      }

      if (canUseAdminTools && !accountNumber) {
        setMessage(result, "Account number is required.", "error");
        return;
      }

      if (heaterPin && !/^\d{4}$/.test(heaterPin)) {
        setMessage(result, "Shared account heater PIN must be 4 digits.", "error");
        return;
      }

      updateButton.disabled = true;
      setMessage(result, "Updating account information...");

      try {
        const memberPatch = {
          phone_number: phone,
          email_address: email
        };

        if (canUseAdminTools) {
          Object.assign(memberPatch, {
            member_name: memberName,
            allow_guest_entry: allowGuestEntry,
            allow_heater_use: allowHeaterUse,
            date_of_birth: dateOfBirth || null,
            guardian_member_id: guardianMemberId || null,
            can_access_independently: canAccessIndependently
          });
        }

        const { error } = await supabaseClient
          .from("account_members")
          .update(memberPatch)
          .eq("id", currentProfile.account_member_id);

        if (error) {
          throw error;
        }

        let accountIdForSharedUpdates = currentProfile.account_id;

        if (canUseAdminTools) {
          let accountMoved = false;

          if (accountNumber !== originalAccountNumber) {
            const moveResult = await moveCurrentMemberToAccount(accountNumber);
            accountIdForSharedUpdates = moveResult?.targetAccountId || accountIdForSharedUpdates;
            accountMoved = true;
          }

          if (stripeCustomerId !== originalStripeCustomerId) {
            await updateAccountStripeCustomerId(accountIdForSharedUpdates, stripeCustomerId);
          }

          const accountTypeUpdate = supabaseClient
            .from("account_members")
            .update({ account_type: accountType });
          const { error: accountTypeError } = accountMoved
            ? await accountTypeUpdate.eq("id", currentProfile.account_member_id)
            : await accountTypeUpdate.eq("account_id", currentProfile.account_id);

          if (accountTypeError) {
            throw accountTypeError;
          }
        }

        if (!isRentalAccount(currentProfile) && heaterPin !== originalHeaterPin) {
          await updateSharedHeaterPin(accountIdForSharedUpdates, heaterPin);
        }

        const metadata = currentSession.user.user_metadata || {};
        const metadataUpdate = {
          data: {
            ...metadata,
            display_name: canUseAdminTools ? memberName : currentProfile.member_name,
            email,
            full_name: canUseAdminTools ? memberName : currentProfile.member_name,
            member_name: canUseAdminTools ? memberName : currentProfile.member_name,
            name: canUseAdminTools ? memberName : currentProfile.member_name,
            phone,
            phone_number: phone
          }
        };

        if (email !== String(currentSession.user.email || "").trim().toLowerCase()) {
          metadataUpdate.email = email;
        }

        const { error: authError } = await supabaseClient.auth.updateUser(metadataUpdate);
        if (authError) {
          throw authError;
        }

        await refreshProfile();
        setMessage(result, "Account information updated.", "success");
      } catch (error) {
        setMessage(result, error.message || "Could not update account information.", "error");
      } finally {
        updateButton.disabled = false;
      }
    });
  }

  function bindPasswordModal() {
    const openButton = byId("openUpdatePasswordBtn");
    const modal = byId("updatePasswordModal");
    const updateButton = byId("updatePasswordBtn");
    const result = byId("passwordResult");

    if (!openButton || !modal || !updateButton) return;

    openButton.addEventListener("click", () => openPasswordModal());

    modal.addEventListener("click", (event) => {
      if (event.target && event.target.hasAttribute("data-close")) {
        modal.hidden = true;
      }
    });

    updateButton.addEventListener("click", async () => {
      const newPassword = String(byId("newPassword")?.value || "");
      const confirmPassword = String(byId("confirmPassword")?.value || "");

      if (newPassword.length < 8) {
        setMessage(result, "Password must be at least 8 characters.", "error");
        return;
      }

      if (newPassword !== confirmPassword) {
        setMessage(result, "Passwords do not match.", "error");
        return;
      }

      updateButton.disabled = true;
      setMessage(result, "Updating password...");

      try {
        const { error } = await supabaseClient.auth.updateUser({
          password: newPassword
        });

        if (error) {
          throw error;
        }

        byId("newPassword").value = "";
        byId("confirmPassword").value = "";
        const shouldCleanRecoveryUrl = recoveryMode;
        recoveryMode = false;
        if (shouldCleanRecoveryUrl) {
          window.RORC_SUPABASE.cleanAuthUrl?.();
        }
        setMessage(result, "Password updated. You are signed in.", "success");

        window.setTimeout(() => {
          modal.hidden = true;
        }, 700);
      } catch (error) {
        setMessage(result, error.message || "Could not update password.", "error");
      } finally {
        updateButton.disabled = false;
      }
    });

    if (recoveryMode) {
      window.setTimeout(() => {
        openPasswordModal("Enter a new password to finish resetting your RORC login.");
      }, 0);
    }
  }

  function bindGlobalKeys() {
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;

      const accountInfoModal = byId("accountInfoModal");
      const updatePasswordModal = byId("updatePasswordModal");

      if (accountInfoModal && !accountInfoModal.hidden) {
        accountInfoModal.hidden = true;
      }

      if (updatePasswordModal && !updatePasswordModal.hidden) {
        updatePasswordModal.hidden = true;
      }
    });
  }

  async function loadRentalBookings() {
    const card = byId("rentalBookingsCard");
    const list = byId("rentalBookings");
    const count = byId("rentalBookingsCount");
    if (!card || !list || !currentSession) return;

    try {
      const response = await fetch("/api/rental-dashboard", {
        headers: { Authorization: `Bearer ${currentSession.access_token}` }
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.success === false) {
        throw new Error(body.error || "Could not load bookings.");
      }

      const bookings = Array.isArray(body.bookings) ? body.bookings : [];
      if (!bookings.length && !isRentalAccount(currentProfile)) {
        card.hidden = true;
        return;
      }

      card.hidden = false;
      if (count) {
        count.textContent = String(bookings.length);
      }
      renderRentalBookings(bookings);
    } catch (error) {
      if (isRentalAccount(currentProfile)) {
        card.hidden = false;
        byId("rentalBookingsDetails")?.setAttribute("open", "");
        if (count) count.textContent = "!";
        list.innerHTML = `<p class="rorc-card-text">${escapeHtml(error.message || "Could not load bookings.")}</p>`;
      } else {
        card.hidden = true;
      }
    }
  }

  function renderRentalBookings(bookings) {
    const list = byId("rentalBookings");
    if (!list) return;
    list._bookings = bookings;
    const details = byId("rentalBookingsDetails");
    const highlight = new URLSearchParams(window.location.search).get("booking") || "";
    if (details && highlight) {
      details.open = true;
    }

    if (!bookings.length) {
      list.innerHTML = `<p class="rorc-card-text">No claimed rental bookings are connected to this account yet.</p>`;
      return;
    }

    list.innerHTML = bookings.map(renderRentalBookingCard).join("");
    list.querySelectorAll("[data-rental-change]").forEach((button) => {
      button.addEventListener("click", () => openRentalChangeDialog(button.dataset.rentalChange || ""));
    });
    list.querySelectorAll("[data-rental-cancel]").forEach((button) => {
      button.addEventListener("click", () => submitRentalCancellationRequest(button.dataset.rentalCancel || ""));
    });

    if (highlight) {
      const card = list.querySelector(`[data-booking-match="${cssEscape(highlight)}"]`)
        || list.querySelector(`[data-booking-id="${cssEscape(highlight)}"]`);
      card?.scrollIntoView({ behavior: "smooth", block: "center" });
      card?.classList.add("is-highlighted");
    }
  }

  function renderRentalBookingCard(booking) {
    const pending = (booking.changeRequests || []).find((request) => request.status === "pending");
    const statusKey = String(booking.rentalStatus || "").trim().toLowerCase();
    const isRejected = statusKey === "rejected";
    const addons = [
      booking.addonCleaningMaintenance && "Standard Maintenance Fee",
      booking.addonTables && "Tables",
      booking.addonChairs && "Chairs",
      booking.addonTarp && "Tarp",
      booking.addonHeater && "Heater",
      booking.addonAc && "AC ($2/hr)",
      booking.addonEarlySetup && "Early Setup",
      booking.addonEarlyDayRental && "Extra Day (Early)",
      booking.addonLateCleanup && "Late Cleanup",
      booking.addonLateDayRental && "Extra Day (Late)",
      booking.specialAccessDiscount && "Special Access discount"
    ].filter(Boolean);
    const publicTime = booking.publicEventStartTime && booking.publicEventEndTime
      ? `<p><strong>Public Event Time:</strong> ${escapeHtml(formatTimeRange(booking.publicEventStartTime, booking.publicEventEndTime))}</p>`
      : "";
    const actions = isRejected
      ? `
        <p class="rental-booking-declined">This rental request was declined. Contact RORC if you have questions, or submit a new rental request with updated details.</p>
        <div class="rorc-actions" style="justify-content:flex-start;">
          <a class="rorc-btn rorc-btn-neutral" href="/support/">Contact Us</a>
          <a class="rorc-btn rorc-btn-gold" href="/rentals/">New Rental Request</a>
        </div>
      `
      : `
        <div class="rorc-actions" style="justify-content:flex-start;">
          <button class="rorc-btn rorc-btn-neutral" type="button" data-rental-change="${escapeHtml(booking.id)}" ${pending ? "disabled" : ""}>Request Change</button>
          <button class="rorc-btn rorc-btn-danger" type="button" data-rental-cancel="${escapeHtml(booking.id)}" ${pending ? "disabled" : ""}>Request Cancellation</button>
        </div>
      `;
    return `
      <article class="rental-booking-card" data-booking-id="${escapeHtml(booking.id)}" data-booking-match="${escapeHtml(booking.bookingNumber || booking.id)}">
        <header>
          <div>
            <span class="rental-booking-kicker">${escapeHtml(booking.bookingNumber || "Rental Booking")}</span>
            <h3>${escapeHtml(booking.eventName || booking.eventType || "Rental")}</h3>
          </div>
          <span class="rental-booking-status">${escapeHtml(String(booking.rentalStatus || "submitted").replaceAll("_", " "))}</span>
        </header>
        <div class="rental-booking-details">
          <p><strong>Date:</strong> ${escapeHtml(formatDate(booking.eventDate))}</p>
          <p><strong>Rental Access:</strong> ${escapeHtml(formatTimeRange(booking.eventStartTime, booking.eventEndTime))}</p>
          ${publicTime}
          <p><strong>Total:</strong> ${escapeHtml(formatCurrency(booking.estimatedTotalCents))}</p>
          <p><strong>Attendance:</strong> ${escapeHtml(booking.estimatedAttendance || "TBD")}</p>
          ${addons.length ? `<p><strong>Add-ons:</strong> ${escapeHtml(addons.join(", "))}</p>` : ""}
          ${pending ? `<p class="rental-booking-pending"><strong>Pending ${escapeHtml(pending.requestType)} request:</strong> waiting for RORC approval.</p>` : ""}
        </div>
        ${actions}
      </article>
    `;
  }

  function timeInputValue(value) {
    const match = String(value || "").match(/^(\d{1,2}):(\d{2})/);
    if (!match) return "";
    return `${String(match[1]).padStart(2, "0")}:${match[2]}`;
  }

  function timeMinutes(value) {
    const match = String(value || "").match(/^(\d{1,2}):(\d{2})/);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    return (hours * 60) + minutes;
  }

  function rentalHoursBetweenInputs(startValue, endValue, fallback = 1) {
    const start = timeMinutes(startValue);
    const end = timeMinutes(endValue);
    if (start === null || end === null || end <= start) return fallback;
    return Math.min(24, Math.max(0.01, Math.round(((end - start) / 60) * 100) / 100));
  }

  function checkboxAttribute(value) {
    return value ? "checked" : "";
  }

  function optionHtml(value, label, selectedValue) {
    const selected = String(selectedValue ?? "") === String(value) ? "selected" : "";
    return `<option value="${escapeHtml(value)}" ${selected}>${escapeHtml(label)}</option>`;
  }

  function yesNoOptions(selectedValue) {
    return [
      optionHtml("true", "Yes", selectedValue ? "true" : "false"),
      optionHtml("false", "No", selectedValue ? "true" : "false")
    ].join("");
  }

  function rentalChangeAddonCheckbox(id, label, checked) {
    return `
      <label class="rental-change-check">
        <input id="${escapeHtml(id)}" type="checkbox" ${checkboxAttribute(checked)} />
        <span>${escapeHtml(label)}</span>
      </label>
    `;
  }

  function openRentalChangeDialog(rentalRequestId) {
    const booking = currentRentalBookings().find((item) => item.id === rentalRequestId);
    if (!booking) return;
    const eventTypeOptions = ["Birthday Party", "Private Party", "Meeting", "Memorial Service", "Other"];
    const currentEventType = booking.eventType || "Other";
    if (currentEventType && !eventTypeOptions.includes(currentEventType)) {
      eventTypeOptions.push(currentEventType);
    }
    const currentRentalType = booking.rentalType === "hourly" ? "hourly" : "all_day";
    const rentalHours = currentRentalType === "hourly"
      ? rentalHoursBetweenInputs(booking.eventStartTime, booking.eventEndTime, Number(booking.rentalHours || 1) || 1)
      : "";
    const overlay = document.createElement("div");
    overlay.className = "rorc-password-modal rental-change-modal";
    overlay.innerHTML = `
      <div class="rorc-password-backdrop" data-close></div>
      <div class="rorc-password-dialog" role="dialog" aria-modal="true" aria-label="Request booking change">
        <button type="button" class="rorc-password-close" data-close>Close</button>
        <h2 class="rorc-card-title">Request Booking Change</h2>
        <div class="rorc-password-form">
          <section class="rental-change-section">
            <h3 class="rental-change-section-title">Contact Information</h3>
            <div class="rental-change-grid">
              <label class="rorc-auth-label">
                <span>Primary Contact Name</span>
                <input id="bookingChangeContactName" class="rorc-auth-input" type="text" value="${escapeHtml(booking.contactName || "")}" />
              </label>
              <label class="rorc-auth-label">
                <span>Phone Number</span>
                <input id="bookingChangeContactPhone" class="rorc-auth-input" type="tel" value="${escapeHtml(booking.contactPhone || "")}" />
              </label>
            </div>
            <div class="rental-change-grid">
              <label class="rorc-auth-label">
                <span>Email Address</span>
                <input id="bookingChangeContactEmail" class="rorc-auth-input" type="email" value="${escapeHtml(booking.contactEmail || "")}" />
              </label>
              <label class="rorc-auth-label">
                <span>Mailing Address</span>
                <input id="bookingChangeContactAddress" class="rorc-auth-input" type="text" value="${escapeHtml(booking.contactAddress || "")}" />
              </label>
            </div>
          </section>

          <section class="rental-change-section">
            <h3 class="rental-change-section-title">Event Details</h3>
            <label class="rorc-auth-label">
              <span>Event Name</span>
              <input id="bookingChangeEventName" class="rorc-auth-input" type="text" value="${escapeHtml(booking.eventName || "")}" />
            </label>
            <div class="rental-change-grid">
              <label class="rorc-auth-label">
                <span>Type of Event</span>
                <select id="bookingChangeEventType" class="rorc-auth-input">
                  ${eventTypeOptions.map((option) => optionHtml(option, option, currentEventType)).join("")}
                </select>
              </label>
              <label class="rorc-auth-label">
                <span>Event Date</span>
                <input id="bookingChangeDate" class="rorc-auth-input" type="date" value="${escapeHtml(booking.eventDate || "")}" />
              </label>
            </div>
            <div class="rental-change-grid">
              <label class="rorc-auth-label">
                <span>Rental Access Start</span>
                <input id="bookingChangeStart" class="rorc-auth-input" type="time" value="${escapeHtml(timeInputValue(booking.eventStartTime))}" />
              </label>
              <label class="rorc-auth-label">
                <span>Rental Access End</span>
                <input id="bookingChangeEnd" class="rorc-auth-input" type="time" value="${escapeHtml(timeInputValue(booking.eventEndTime))}" />
              </label>
            </div>
            <div class="rental-change-grid">
              <label class="rorc-auth-label">
                <span>Public Event Start</span>
                <input id="bookingChangePublicStart" class="rorc-auth-input" type="time" value="${escapeHtml(timeInputValue(booking.publicEventStartTime))}" />
              </label>
              <label class="rorc-auth-label">
                <span>Public Event End</span>
                <input id="bookingChangePublicEnd" class="rorc-auth-input" type="time" value="${escapeHtml(timeInputValue(booking.publicEventEndTime))}" />
              </label>
            </div>
            <div class="rental-change-grid">
              <label class="rorc-auth-label">
                <span>Estimated Attendance</span>
                <input id="bookingChangeAttendance" class="rorc-auth-input" type="number" min="1" step="1" value="${escapeHtml(booking.estimatedAttendance || "")}" />
              </label>
              <label class="rorc-auth-label">
                <span>Food or Drinks</span>
                <select id="bookingChangeFood" class="rorc-auth-input">${yesNoOptions(Boolean(booking.foodOrDrinks))}</select>
              </label>
            </div>
            <div class="rental-change-grid">
              <label class="rorc-auth-label">
                <span>Alcohol</span>
                <select id="bookingChangeAlcohol" class="rorc-auth-input">
                  ${optionHtml("No", "No", booking.alcohol || "No")}
                  ${optionHtml("Yes", "Yes", booking.alcohol || "No")}
                </select>
              </label>
              <label class="rorc-auth-label">
                <span>Private Event</span>
                <select id="bookingChangePrivate" class="rorc-auth-input">${yesNoOptions(booking.isPrivateEvent !== false)}</select>
              </label>
            </div>
          </section>

          <section class="rental-change-section">
            <h3 class="rental-change-section-title">Rental & Add-Ons</h3>
            <div class="rental-change-grid">
              <label class="rorc-auth-label">
                <span>Rental Type</span>
                <select id="bookingChangeRentalType" class="rorc-auth-input">
                  ${optionHtml("all_day", "All Day", currentRentalType)}
                  ${optionHtml("hourly", "By the Hour", currentRentalType)}
                </select>
              </label>
              <label class="rorc-auth-label">
                <span>Billable Hours (auto)</span>
                <input id="bookingChangeRentalHours" class="rorc-auth-input" type="number" min="0.25" max="24" step="0.25" value="${escapeHtml(rentalHours)}" readonly />
              </label>
            </div>
            <div class="rental-change-check-grid">
              ${rentalChangeAddonCheckbox("bookingChangeCleaning", "Standard Maintenance Fee", booking.addonCleaningMaintenance)}
              ${rentalChangeAddonCheckbox("bookingChangeTables", "Tables", booking.addonTables)}
              ${rentalChangeAddonCheckbox("bookingChangeChairs", "Chairs", booking.addonChairs)}
              ${rentalChangeAddonCheckbox("bookingChangeTarp", "Tarp", booking.addonTarp)}
              ${rentalChangeAddonCheckbox("bookingChangeHeater", "Heater", booking.addonHeater)}
              ${rentalChangeAddonCheckbox("bookingChangeAc", "AC ($2/hr)", booking.addonAc)}
              ${rentalChangeAddonCheckbox("bookingChangeEarlySetup", "Early Setup", booking.addonEarlySetup)}
              ${rentalChangeAddonCheckbox("bookingChangeEarlyDay", "Extra Day (Early)", booking.addonEarlyDayRental)}
              ${rentalChangeAddonCheckbox("bookingChangeLateCleanup", "Late Cleanup", booking.addonLateCleanup)}
              ${rentalChangeAddonCheckbox("bookingChangeLateDay", "Extra Day (Late)", booking.addonLateDayRental)}
            </div>
          </section>

          <label class="rorc-auth-label">
            <span>Message For RORC</span>
            <textarea id="bookingChangeMessage" class="rorc-auth-input" rows="4" placeholder="Describe what needs to change."></textarea>
          </label>
          <div class="rorc-actions" style="justify-content:flex-start;">
            <button class="rorc-btn rorc-btn-neutral" type="button" data-close>Cancel</button>
            <button id="bookingChangeSubmit" class="rorc-btn rorc-btn-gold" type="button">Submit Request</button>
          </div>
          <p id="bookingChangeResult" class="rorc-card-text"></p>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener("click", (event) => {
      if (event.target?.hasAttribute("data-close")) close();
    });
    const syncRentalHours = () => {
      const type = byId("bookingChangeRentalType")?.value || "all_day";
      const hoursInput = byId("bookingChangeRentalHours");
      if (!hoursInput) return;
      if (type !== "hourly") {
        hoursInput.value = "";
        return;
      }
      hoursInput.value = String(rentalHoursBetweenInputs(
        byId("bookingChangeStart")?.value || "",
        byId("bookingChangeEnd")?.value || "",
        rentalHours || 1
      ));
    };
    ["bookingChangeRentalType", "bookingChangeStart", "bookingChangeEnd"].forEach((id) => {
      byId(id)?.addEventListener("input", syncRentalHours);
      byId(id)?.addEventListener("change", syncRentalHours);
    });
    syncRentalHours();
    overlay.querySelector("#bookingChangeSubmit")?.addEventListener("click", async () => {
      const rentalType = byId("bookingChangeRentalType")?.value || "all_day";
      await submitRentalChangeRequest(rentalRequestId, {
        contact_name: byId("bookingChangeContactName")?.value || "",
        contact_phone: byId("bookingChangeContactPhone")?.value || "",
        contact_email: byId("bookingChangeContactEmail")?.value || "",
        contact_address: byId("bookingChangeContactAddress")?.value || "",
        event_name: byId("bookingChangeEventName")?.value || "",
        event_type: byId("bookingChangeEventType")?.value || "",
        event_date: byId("bookingChangeDate")?.value || "",
        event_start_time: byId("bookingChangeStart")?.value || "",
        event_end_time: byId("bookingChangeEnd")?.value || "",
        public_event_start_time: byId("bookingChangePublicStart")?.value || "",
        public_event_end_time: byId("bookingChangePublicEnd")?.value || "",
        estimated_attendance: byId("bookingChangeAttendance")?.value || "",
        food_or_drinks: byId("bookingChangeFood")?.value === "true",
        alcohol: byId("bookingChangeAlcohol")?.value || "No",
        is_private_event: byId("bookingChangePrivate")?.value !== "false",
        rental_type: rentalType,
        rental_hours: rentalType === "hourly"
          ? rentalHoursBetweenInputs(byId("bookingChangeStart")?.value || "", byId("bookingChangeEnd")?.value || "", 1)
          : null,
        addon_cleaning_maintenance: Boolean(byId("bookingChangeCleaning")?.checked),
        addon_tables: Boolean(byId("bookingChangeTables")?.checked),
        addon_chairs: Boolean(byId("bookingChangeChairs")?.checked),
        addon_tarp: Boolean(byId("bookingChangeTarp")?.checked),
        addon_heater: Boolean(byId("bookingChangeHeater")?.checked),
        addon_ac: Boolean(byId("bookingChangeAc")?.checked),
        addon_early_setup: Boolean(byId("bookingChangeEarlySetup")?.checked),
        addon_early_day_rental: Boolean(byId("bookingChangeEarlyDay")?.checked),
        addon_late_cleanup: Boolean(byId("bookingChangeLateCleanup")?.checked),
        addon_late_day_rental: Boolean(byId("bookingChangeLateDay")?.checked),
        adminNotes: byId("bookingChangeMessage")?.value || ""
      }, overlay);
    });
  }

  function currentRentalBookings() {
    const list = byId("rentalBookings");
    return Array.isArray(list?._bookings) ? list._bookings : [];
  }

  async function submitRentalCancellationRequest(rentalRequestId) {
    const confirmed = window.confirm("Submit a cancellation request for this booking?");
    if (!confirmed) return;
    await postRentalDashboardRequest({
      rentalRequestId,
      requestType: "cancel",
      message: "Renter requested cancellation from dashboard."
    });
    await loadRentalBookings();
  }

  async function submitRentalChangeRequest(rentalRequestId, requestedPayload, overlay) {
    const result = overlay.querySelector("#bookingChangeResult");
    const submit = overlay.querySelector("#bookingChangeSubmit");
    submit.disabled = true;
    submit.textContent = "Submitting...";
    result.textContent = "Submitting request...";
    result.dataset.tone = "default";
    try {
      await postRentalDashboardRequest({
        rentalRequestId,
        requestType: "update",
        requestedPayload
      });
      result.textContent = "Request submitted for RORC approval.";
      result.dataset.tone = "success";
      await loadRentalBookings();
      window.setTimeout(() => overlay.remove(), 700);
    } catch (error) {
      result.textContent = error.message || "Could not submit request.";
      result.dataset.tone = "error";
      submit.disabled = false;
      submit.textContent = "Submit Request";
    }
  }

  async function postRentalDashboardRequest(payload) {
    const { data } = await supabaseClient.auth.getSession();
    const token = data.session?.access_token || currentSession?.access_token || "";
    if (!token) {
      window.location.href = LOGIN_PATH;
      return null;
    }
    const response = await fetch("/api/rental-dashboard", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success === false) {
      throw new Error(body.error || "Could not submit booking request.");
    }
    return body;
  }

  async function init() {
    const container = byId("memberDashboard");

    try {
      const ready = await loadSessionAndProfile();
      if (!ready) return;

      renderDashboard();
      revealPrivateAppCard();
      hydrateAccountForm();
      configureBillingButton();
      bindAccountInvite();
      bindAccountInfoModal();
      bindPasswordModal();
      bindGlobalKeys();
      await loadRentalBookings();
    } catch (error) {
      if (container) {
        container.innerHTML = `
          <p>Could not load your Supabase member profile.</p>
          <p>${escapeHtml(error.message || "Please log in again.")}</p>
          <p><a href="${LOGIN_PATH}">Return to login</a></p>
        `;
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
