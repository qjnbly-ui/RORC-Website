(function () {
  const script = document.currentScript;
  const formId = String(script?.dataset?.formId || "");
  const token = new URLSearchParams(window.location.hash.slice(1)).get("draft") || "";
  if (!formId || !token) return;

  window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.search}`);

  function setValue(key, value) {
    if (formId === "membership" && key === "planId") {
      const plan = document.getElementById("membershipPlan");
      if (plan) plan.value = value;
      document.querySelector(`[data-plan="${CSS.escape(String(value))}"]`)?.click();
      return;
    }
    const fields = Array.from(document.querySelectorAll(`[name="${CSS.escape(key)}"]`));
    if (!fields.length) return;
    if (fields[0].type === "radio") {
      const selected = fields.find((field) => String(field.value).toLowerCase() === String(value).toLowerCase());
      if (selected) {
        selected.checked = true;
        selected.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return;
    }
    const field = fields[0];
    field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function notice(message, state) {
    let element = document.getElementById("rorc-draft-notice");
    if (!element) {
      element = document.createElement("p");
      element.id = "rorc-draft-notice";
      element.setAttribute("role", "status");
      element.style.cssText = "max-width:960px;margin:16px auto;padding:12px 16px;border-radius:10px;background:#eef7f1;color:#173d28;font-weight:600";
      document.querySelector("form")?.before(element);
    }
    element.textContent = message;
    if (state === "error") {
      element.style.background = "#fff0f0";
      element.style.color = "#7a2020";
    }
  }

  async function load() {
    if (formId === "membership" && !window.RORC_MEMBERSHIP_SIGNUP_READY) {
      await new Promise((resolve) => document.addEventListener("rorc:membership-ready", resolve, { once: true }));
    }
    notice("Loading the information collected by the RORC receptionist…");
    try {
      const response = await fetch("/api/form-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, formId }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.success) throw new Error(body.error || "Could not load this draft.");
      Object.entries(body.draft?.answers || {}).forEach(([key, value]) => setValue(key, value));
      notice("The receptionist filled in the information you provided. Please review it and complete the remaining required sections before submitting.");
    } catch (error) {
      notice(error.message || "Could not load this draft.", "error");
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load, { once: true });
  else load();
})();
