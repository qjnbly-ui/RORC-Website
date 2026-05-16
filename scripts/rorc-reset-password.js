(function() {
  function byId(id) {
    return document.getElementById(id);
  }

  function dashboardUrl() {
    return new URL("/member-dashboard/", window.location.origin).toString();
  }

  async function init() {
    const resetButton = byId("resetBtn");
    const resetEmail = byId("resetEmail");
    const resetResult = byId("resetResult");

    if (!resetButton || !resetEmail || !resetResult) return;

    resetButton.addEventListener("click", async () => {
      const email = resetEmail.value.trim().toLowerCase();

      if (!email) {
        resetResult.textContent = "Please enter your email address.";
        return;
      }

      resetButton.disabled = true;
      resetResult.textContent = "Sending password reset email...";

      try {
        const client = await window.RORC_SUPABASE.getClient();
        const { error } = await client.auth.resetPasswordForEmail(email, {
          redirectTo: dashboardUrl()
        });

        if (error) {
          throw error;
        }

        resetResult.textContent = "If that email is on file, a password reset link has been sent.";
        resetEmail.value = "";
      } catch (error) {
        resetResult.textContent = error.message || "Could not process password reset.";
      } finally {
        resetButton.disabled = false;
      }
    });

    resetEmail.addEventListener("keypress", (event) => {
      if (event.key === "Enter") {
        resetButton.click();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
