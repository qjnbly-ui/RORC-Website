(function() {
  const LOGIN_PATH = "/membership-login/";
  const STRIPE_FALLBACK_PORTAL = "https://payments.ruthobenchainrc.com/p/login/eVaeWh2tN0vxgSs288";

  let supabaseClient = null;
  let currentSession = null;
  let currentProfile = null;
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

  function canManageBilling(profile) {
    return Boolean(profile?.is_billing_owner || isAccountManager(profile));
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
      window.location.href = LOGIN_PATH;
      return false;
    }

    if (!result.profile) {
      throw new Error("Your login is valid, but no linked member profile was found.");
    }

    currentSession = result.session;
    currentProfile = result.profile;
    visibleProfiles = result.profiles || [];

    return true;
  }

  function renderDashboard() {
    const container = byId("memberDashboard");
    if (!container || !currentProfile) return;

    const sameAccountMembers = visibleProfiles
      .filter((profile) => profile.account_id === currentProfile.account_id)
      .map((profile) => profile.member_name)
      .filter(Boolean);

    container.innerHTML = `
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
    }
  }

  function hydrateAccountForm() {
    const accountPhone = byId("accountPhone");
    const accountEmail = byId("accountEmail");

    if (accountPhone) {
      accountPhone.value = currentProfile?.phone_number || "";
    }

    if (accountEmail) {
      accountEmail.value = currentProfile?.email_address || currentSession?.user?.email || "";
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
          }
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

    if (!canManageBilling(currentProfile)) {
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
    renderDashboard();
    hydrateAccountForm();
  }

  function bindAccountInfoModal() {
    const openButton = byId("openAccountInfoBtn");
    const modal = byId("accountInfoModal");
    const updateButton = byId("updateAccountBtn");
    const result = byId("accountResult");

    if (!openButton || !modal || !updateButton) return;

    openButton.addEventListener("click", () => {
      hydrateAccountForm();
      setMessage(result, "");
      modal.hidden = false;
      byId("accountPhone")?.focus();
    });

    modal.addEventListener("click", (event) => {
      if (event.target && event.target.hasAttribute("data-close")) {
        modal.hidden = true;
      }
    });

    updateButton.addEventListener("click", async () => {
      const phone = String(byId("accountPhone")?.value || "").trim();
      const email = String(byId("accountEmail")?.value || "").trim().toLowerCase();

      if (!email) {
        setMessage(result, "Email address is required.", "error");
        return;
      }

      updateButton.disabled = true;
      setMessage(result, "Updating account information...");

      try {
        const { error } = await supabaseClient
          .from("account_members")
          .update({
            phone_number: phone,
            email_address: email
          })
          .eq("id", currentProfile.account_member_id);

        if (error) {
          throw error;
        }

        const metadata = currentSession.user.user_metadata || {};
        const metadataUpdate = {
          data: {
            ...metadata,
            display_name: currentProfile.member_name,
            email,
            full_name: currentProfile.member_name,
            member_name: currentProfile.member_name,
            name: currentProfile.member_name,
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
