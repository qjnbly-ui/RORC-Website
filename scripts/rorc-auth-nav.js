(function() {
  const DASHBOARD_PATH = "/member-dashboard/";
  const LOGIN_PATH = "/membership-login/";
  const SUPABASE_HELPER_SRC = "/scripts/rorc-supabase-client.js";
  const LEGACY_STORAGE_KEY = "memberData";

  let helperPromise = null;

  function clearLegacyMemberData() {
    try {
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch (error) {
      // Ignore storage failures and keep navigation usable.
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

  function setHintState(signedIn, member) {
    const html = document.documentElement;
    html.dataset.rorcAuthHint = signedIn ? "signed-in" : "signed-out";
    window.__RORC_AUTH_HINT__ = {
      signedIn,
      member: signedIn ? member : null
    };
  }

  function loadHelper() {
    if (window.RORC_SUPABASE) {
      return Promise.resolve(window.RORC_SUPABASE);
    }

    if (helperPromise) {
      return helperPromise;
    }

    helperPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${SUPABASE_HELPER_SRC}"]`);

      if (existing) {
        existing.addEventListener("load", () => resolve(window.RORC_SUPABASE), { once: true });
        existing.addEventListener("error", () => reject(new Error("Could not load RORC Supabase helper.")), { once: true });
        return;
      }

      const script = document.createElement("script");
      script.src = SUPABASE_HELPER_SRC;
      script.onload = () => resolve(window.RORC_SUPABASE);
      script.onerror = () => reject(new Error("Could not load RORC Supabase helper."));
      document.head.appendChild(script);
    });

    return helperPromise;
  }

  async function getAuthState() {
    const helper = await loadHelper();
    const result = await helper.getCurrentMemberProfile();

    return {
      signedIn: !!result.session,
      member: result.profile,
      session: result.session
    };
  }

  async function signOut() {
    const helper = await loadHelper();
    const client = await helper.getClient();
    await client.auth.signOut({ scope: "local" });
    clearLegacyMemberData();
    setHintState(false, null);
  }

  function bindLogout(link) {
    if (!link || link.dataset.authNavLogoutBound === "true") {
      return;
    }

    link.dataset.authNavLogoutBound = "true";
    link.addEventListener("click", async (event) => {
      if (!window.location.pathname.startsWith(DASHBOARD_PATH)) {
        return;
      }

      event.preventDefault();
      await signOut();
      window.location.href = LOGIN_PATH;
    });
  }

  async function hydrateNav() {
    const link = document.querySelector(".site-menu-login");
    if (!link) {
      return;
    }

    let authState;

    try {
      authState = await getAuthState();
    } catch (error) {
      authState = { signedIn: false, member: null };
    }

    const onDashboard = window.location.pathname.startsWith(DASHBOARD_PATH);

    if (authState.signedIn) {
      setHintState(true, authState.member);

      if (onDashboard) {
        applyLogoutNav(link);
        bindLogout(link);
      } else {
        applyPortalNav(link);
      }
      return;
    }

    clearLegacyMemberData();
    setHintState(false, null);

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

  window.RORC_AUTH_NAV = {
    hydrate: hydrateNav,
    signOut
  };
})();
