(function() {
  const DASHBOARD_PATH = "/member-dashboard/";
  const LOGIN_PATH = "/membership-login/";
  const SUPABASE_HELPER_SRC = "/scripts/rorc-supabase-client.js";
  const LEGACY_STORAGE_KEY = "memberData";
  const AUTH_HINT_CACHE_KEY = "rorcAuthHint";

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
    link.dataset.authNavMode = "portal";
  }

  function applyLoginNav(link) {
    if (!link) {
      return;
    }

    rememberOriginalNav(link);
    const originalText = link.dataset.authNavOriginalText || "Login";
    const originalHref = link.dataset.authNavOriginalHref || LOGIN_PATH;
    const originalTarget = link.dataset.authNavOriginalTarget || "";
    const originalRel = link.dataset.authNavOriginalRel || "";

    link.textContent = originalText;
    link.setAttribute("href", originalHref);
    link.removeAttribute("target");
    link.removeAttribute("rel");
    if (originalTarget) link.setAttribute("target", originalTarget);
    if (originalRel) link.setAttribute("rel", originalRel);
    link.setAttribute("aria-label", originalText);
    link.dataset.authNavMode = "login";
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
    link.dataset.authNavMode = "logout";
  }

  function setHintState(signedIn, member) {
    const html = document.documentElement;
    html.dataset.rorcAuthHint = signedIn ? "signed-in" : "signed-out";
    window.__RORC_AUTH_HINT__ = {
      signedIn,
      member: signedIn ? member : null
    };

    try {
      window.sessionStorage.setItem(
        AUTH_HINT_CACHE_KEY,
        JSON.stringify({
          signedIn: Boolean(signedIn),
          updatedAt: Date.now()
        })
      );
    } catch (error) {
      // Ignore storage failures; this is an optional UX cache.
    }
  }

  function readCachedHint() {
    try {
      const raw = window.sessionStorage.getItem(AUTH_HINT_CACHE_KEY);
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      if (typeof parsed.signedIn !== "boolean") return null;
      return parsed;
    } catch (error) {
      return null;
    }
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
    const session = await helper.getSession();

    return {
      signedIn: Boolean(session),
      member: null,
      session
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
      if (link.dataset.authNavMode !== "logout") {
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

    rememberOriginalNav(link);

    const onDashboard = window.location.pathname.startsWith(DASHBOARD_PATH);
    const cachedHint = readCachedHint();

    if (cachedHint?.signedIn && onDashboard) {
      if (onDashboard) {
        applyLogoutNav(link);
        bindLogout(link);
      }
      document.documentElement.dataset.rorcAuthHint = "signed-in";
    } else if (!onDashboard) {
      applyLoginNav(link);
    }

    let authState;

    try {
      authState = await getAuthState();
    } catch (error) {
      authState = { signedIn: false, member: null };
    }

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

    applyLoginNav(link);
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
