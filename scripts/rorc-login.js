(function() {
  const DASHBOARD_PATH = "/member-dashboard/";
  const AUTH_HINT_CACHE_KEY = "rorcAuthHint";

  function byId(id) {
    return document.getElementById(id);
  }

  function setResult(message, tone = "default") {
    const result = byId("result");
    if (!result) return;
    result.textContent = message;
    result.dataset.tone = tone;
  }

  function dashboardUrl() {
    return new URL(DASHBOARD_PATH, window.location.origin).toString();
  }

  async function getClient() {
    if (!window.RORC_SUPABASE) {
      throw new Error("Supabase is not configured on this page.");
    }

    return window.RORC_SUPABASE.getClient();
  }

  async function redirectIfSignedIn() {
    const client = await getClient();
    const { data, error } = await client.auth.getSession();

    if (error) {
      throw error;
    }

    if (data.session) {
      window.location.href = DASHBOARD_PATH;
    }
  }

  async function sendLoginLink(email) {
    const client = await getClient();
    const { error } = await client.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: dashboardUrl(),
        shouldCreateUser: false
      }
    });

    if (error) {
      throw error;
    }
  }

  async function signInWithPassword(email, password) {
    const client = await getClient();
    const { error } = await client.auth.signInWithPassword({
      email,
      password
    });

    if (error) {
      throw error;
    }
  }

  async function resetPassword(email) {
    const client = await getClient();
    const { error } = await client.auth.resetPasswordForEmail(email, {
      redirectTo: dashboardUrl()
    });

    if (error) {
      throw error;
    }
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    if (!button.dataset.originalText) {
      button.dataset.originalText = button.textContent;
    }
    button.disabled = busy;
    button.textContent = busy ? label : button.dataset.originalText;
  }

  function readEmail() {
    return String(byId("login")?.value || "").trim().toLowerCase();
  }

  function readPassword() {
    return String(byId("password")?.value || "");
  }

  function cacheSignedInHint() {
    try {
      window.sessionStorage.setItem(
        AUTH_HINT_CACHE_KEY,
        JSON.stringify({
          signedIn: true,
          updatedAt: Date.now()
        })
      );
    } catch (error) {
      // Ignore storage failures.
    }
  }

  async function init() {
    const params = new URLSearchParams(window.location.search);
    if (params.get("signup") === "success") {
      setResult("Membership signup complete. Use Email Login Link with your signup email to open your account.", "success");
    } else if (params.get("signup") === "invite") {
      setResult("Contract accepted. Use Email Login Link with your invited email to open your account.", "success");
    } else if (params.get("signup") === "pending_review") {
      setResult("Contract received. Log in with the password you created. Your account is pending RORC admin approval before facility access is enabled.", "success");
    } else if (params.get("signup") === "error") {
      setResult(params.get("message") || "Signup payment was received, but account activation could not be verified automatically.", "error");
    }

    try {
      await redirectIfSignedIn();
    } catch (error) {
      setResult("Could not check current login status.", "error");
    }

    const loginButton = byId("loginBtn");
    const loginLinkButton = byId("magicLinkBtn");
    const resetPasswordButton = byId("resetPasswordBtn");
    const passwordInput = byId("password");

    loginButton?.addEventListener("click", async () => {
      const email = readEmail();
      const password = readPassword();

      if (!email || !password) {
        setResult("Enter email and password, or use Email Login Link.", "error");
        return;
      }

      setBusy(loginButton, true, "Logging in...");
      setResult("Checking login...", "default");

      try {
        await signInWithPassword(email, password);
        cacheSignedInHint();
        setResult("Login successful...", "success");
        window.location.href = DASHBOARD_PATH;
      } catch (error) {
        setResult(error.message || "Could not log in.", "error");
      } finally {
        setBusy(loginButton, false);
      }
    });

    loginLinkButton?.addEventListener("click", async () => {
      const email = readEmail();

      if (!email) {
        setResult("Enter the email tied to your membership.", "error");
        return;
      }

      setBusy(loginLinkButton, true, "Sending...");
      setResult("Sending secure login link...", "default");

      try {
        await sendLoginLink(email);
        setResult("Check your email for the secure RORC login link.", "success");
      } catch (error) {
        setResult(error.message || "Could not send login link.", "error");
      } finally {
        setBusy(loginLinkButton, false);
      }
    });

    resetPasswordButton?.addEventListener("click", async () => {
      const email = readEmail();

      if (!email) {
        setResult("Enter your email first, then reset password.", "error");
        return;
      }

      setBusy(resetPasswordButton, true, "Sending...");

      try {
        await resetPassword(email);
        setResult("If this email is on file, a password reset link has been sent.", "success");
      } catch (error) {
        setResult(error.message || "Could not send password reset.", "error");
      } finally {
        setBusy(resetPasswordButton, false);
      }
    });

    passwordInput?.addEventListener("keypress", (event) => {
      if (event.key === "Enter") {
        loginButton?.click();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
