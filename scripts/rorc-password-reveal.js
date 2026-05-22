(function() {
  const INPUT_SELECTOR = 'input[type="password"]:not([data-password-reveal-ignore])';

  function setButtonState(button, input) {
    const isVisible = input.type === "text";
    button.textContent = isVisible ? "Hide" : "Show";
    button.setAttribute("aria-label", `${isVisible ? "Hide" : "Show"} ${input.name || input.id || "password"}`);
    button.setAttribute("aria-pressed", String(isVisible));
  }

  function setupInput(input) {
    if (!input || input.dataset.passwordRevealReady === "true") return;

    input.dataset.passwordRevealReady = "true";

    let wrapper = input.closest(".password-reveal-field");
    if (!wrapper) {
      wrapper = document.createElement("span");
      wrapper.className = "password-reveal-field";
      input.parentNode?.insertBefore(wrapper, input);
      wrapper.appendChild(input);
    }

    if (wrapper.querySelector(".password-reveal-toggle")) return;

    const button = document.createElement("button");
    button.className = "password-reveal-toggle";
    button.type = "button";
    setButtonState(button, input);

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      input.type = input.type === "password" ? "text" : "password";
      setButtonState(button, input);
      input.focus({ preventScroll: true });
    });

    wrapper.appendChild(button);
  }

  function setupAll(root = document) {
    if (root.matches?.(INPUT_SELECTOR)) {
      setupInput(root);
    }
    root.querySelectorAll?.(INPUT_SELECTOR).forEach(setupInput);
  }

  function init() {
    setupAll();

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            setupAll(node);
          }
        });
      });
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  window.RORC_PASSWORD_REVEAL = { refresh: setupAll };
})();
