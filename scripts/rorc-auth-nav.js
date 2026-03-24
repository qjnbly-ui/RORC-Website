(function() {
  const STORAGE_KEY = "memberData";
  const DASHBOARD_PATH = "/member-dashboard/";
  const LOGIN_PATH = "/membership-login/";
  const VERIFY_URL = "/api/verify-member-session";

  function getAuthHint() {
    const hint = window.__RORC_AUTH_HINT__;
    if (hint && typeof hint === "object") {
      return hint;
    }

    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return { signedIn: false, member: null };
      }

      const member = JSON.parse(raw);
      if (!member || typeof member !== "object") {
        return { signedIn: false, member: null };
      }

      const memberName = String(member["Member Name"] || "").trim();
      return {
        signedIn: !!memberName,
        member: memberName ? member : null
      };
    } catch (error) {
      return { signedIn: false, member: null };
    }
  }

  function setHintState(signedIn, member) {
    const html = document.documentElement;
    html.dataset.rorcAuthHint = signedIn ? "signed-in" : "signed-out";
    window.__RORC_AUTH_HINT__ = {
      signedIn,
      member: signedIn ? member : null
    };
  }

  function persistMember(member) {
    try {
      if (member) {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(member));
      } else {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    } catch (error) {
      // Ignore storage failures and keep the UI usable.
    }
  }

  function rememberOriginalNav(link) {
    if (!link || link.dataset.authNavOriginalText) {
      return;
    }

    link.dataset.authNavOriginalText = link.textContent;
    link.dataset.authNavOriginalHref = link.getAttribute("href") || "";
    link.dataset.authNavOriginalTarget = link.getAttribute("target") || "";
    link.dataset.authNavOriginalRel = link.getAttribute("rel") || "";
  }

  function applyPortalNav(link) {
    if (!link) {
      return;
    }

    rememberOriginalNav(link);
    link.textContent = "Portal";
    link.setAttribute("href", DASHBOARD_PATH);
    link.removeAttribute("target");
    link.removeAttribute("rel");
    link.setAttribute("aria-label", "Portal");
  }

  function applyLogoutNav(link) {
    if (!link) {
      return;
    }

    rememberOriginalNav(link);
    link.textContent = "Logout";
    link.setAttribute("href", LOGIN_PATH);
    link.removeAttribute("target");
    link.removeAttribute("rel");
    link.setAttribute("aria-label", "Logout");
  }

  function restoreSignedOutNav(link) {
    if (!link) {
      return;
    }

    const text = link.dataset.authNavOriginalText;
    const href = link.dataset.authNavOriginalHref;
    const target = link.dataset.authNavOriginalTarget;
    const rel = link.dataset.authNavOriginalRel;

    if (text) {
      link.textContent = text;
      link.setAttribute("aria-label", text);
    }

    if (href) {
      link.setAttribute("href", href);
    } else {
      link.removeAttribute("href");
    }

    if (target) {
      link.setAttribute("target", target);
    } else {
      link.removeAttribute("target");
    }

    if (rel) {
      link.setAttribute("rel", rel);
    } else {
      link.removeAttribute("rel");
    }
  }

  function bindLogout(link) {
    if (!link || link.dataset.authNavLogoutBound === "true") {
      return;
    }

    link.dataset.authNavLogoutBound = "true";
    link.addEventListener("click", function(event) {
      if (!window.__RORC_AUTH_HINT__ || !window.__RORC_AUTH_HINT__.signedIn) {
        return;
      }

      if (!window.location.pathname.startsWith(DASHBOARD_PATH)) {
        return;
      }

      event.preventDefault();
      persistMember(null);
      setHintState(false, null);
      restoreSignedOutNav(link);
      window.location.href = LOGIN_PATH;
    });
  }

  function hydrateNav() {
    const link = document.querySelector(".site-menu-login");
    if (!link) {
      return null;
    }

    const hint = getAuthHint();
    const onDashboard = window.location.pathname.startsWith(DASHBOARD_PATH);

    if (hint.signedIn) {
      if (onDashboard) {
        applyLogoutNav(link);
        bindLogout(link);
      } else {
        applyPortalNav(link);
      }
    } else if (!onDashboard) {
      restoreSignedOutNav(link);
    }

    return link;
  }

  async function verifySession() {
    const hint = getAuthHint();
    if (!hint.signedIn || !hint.member) {
      return;
    }

    let response;
    let data;

    try {
      response = await fetch(VERIFY_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          member: hint.member
        })
      });

      data = await response.json();
    } catch (error) {
      return;
    }

    if (response.ok && data.success && data.authenticated && data.member) {
      persistMember(data.member);
      setHintState(true, data.member);
      hydrateNav();
      return;
    }

    if (!(response.ok && data.success && data.authenticated === false)) {
      return;
    }

    persistMember(null);
    setHintState(false, null);

    const link = document.querySelector(".site-menu-login");
    const onDashboard = window.location.pathname.startsWith(DASHBOARD_PATH);

    if (onDashboard) {
      window.location.href = LOGIN_PATH;
      return;
    }

    restoreSignedOutNav(link);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", hydrateNav, { once: true });
  } else {
    hydrateNav();
  }

  window.setTimeout(verifySession, 0);
})();
