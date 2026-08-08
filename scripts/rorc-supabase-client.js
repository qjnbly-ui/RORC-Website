(function() {
  if (window.RORC_SUPABASE) {
    return;
  }

  const SUPABASE_URL = "https://aedvuofiodtsgijcxyqx.supabase.co";
  const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_lNxmEUnsIUXeoAe9MLp0BA_QInzqALY";
  const SUPABASE_SDK_URL = "/RORC%20App/vendor/supabase.min.js?v=2.112.2";
  const initialAuthParams = readAuthParams();

  let libraryPromise = null;
  let clientPromise = null;
  let realtimeRecoveryTimer = null;
  let lastAuthEvent = "";
  const authEventSubscribers = new Set();

  function readAuthParams() {
    const params = new URLSearchParams(window.location.search);
    const hash = window.location.hash.replace(/^#/, "");

    if (hash) {
      const hashParams = new URLSearchParams(hash);
      hashParams.forEach((value, key) => {
        if (!params.has(key)) {
          params.set(key, value);
        }
      });
    }

    return {
      error: params.get("error") || "",
      errorDescription: params.get("error_description") || "",
      type: params.get("type") || ""
    };
  }

  function loadSupabaseLibrary() {
    if (window.supabase && typeof window.supabase.createClient === "function") {
      return Promise.resolve(window.supabase);
    }

    if (libraryPromise) {
      return libraryPromise;
    }

    libraryPromise = new Promise((resolve, reject) => {
      const expectedUrl = new URL(SUPABASE_SDK_URL, window.location.origin).href;
      const existing = [...document.scripts].find((candidate) => candidate.src === expectedUrl);

      if (existing) {
        existing.addEventListener("load", () => resolve(window.supabase), { once: true });
        existing.addEventListener("error", () => reject(new Error("Could not load Supabase client.")), { once: true });
        return;
      }

      const script = document.createElement("script");
      script.src = SUPABASE_SDK_URL;
      script.async = true;
      script.onload = () => resolve(window.supabase);
      script.onerror = () => reject(new Error("Could not load Supabase client."));
      document.head.appendChild(script);
    });

    return libraryPromise;
  }

  async function getClient() {
    if (clientPromise) {
      return clientPromise;
    }

    clientPromise = loadSupabaseLibrary().then((supabaseLibrary) => {
      if (!supabaseLibrary || typeof supabaseLibrary.createClient !== "function") {
        throw new Error("Supabase client library is unavailable.");
      }

      let client = null;
      const handleHeartbeat = (status) => {
        if (!["timeout", "error", "disconnected"].includes(status) || realtimeRecoveryTimer) {
          return;
        }

        realtimeRecoveryTimer = window.setTimeout(() => {
          realtimeRecoveryTimer = null;
          if (client?.realtime && !client.realtime.isConnected()) {
            client.realtime.connect();
          }
        }, 1000);
      };

      client = supabaseLibrary.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
        auth: {
          autoRefreshToken: true,
          detectSessionInUrl: true,
          persistSession: true
        },
        realtime: {
          worker: true,
          heartbeatIntervalMs: 15000,
          heartbeatCallback: handleHeartbeat
        }
      });

      client.auth.onAuthStateChange((event, session) => {
        lastAuthEvent = event;
        authEventSubscribers.forEach((subscriber) => subscriber(event, session));
      });

      return client;
    });

    return clientPromise;
  }

  async function getSession() {
    const client = await getClient();
    const { data, error } = await client.auth.getSession();

    if (error) {
      throw error;
    }

    return data.session || null;
  }

  async function getProfiles() {
    const client = await getClient();
    const { data, error } = await client
      .from("account_member_profiles")
      .select("*")
      .order("account_number", { ascending: true })
      .order("member_name", { ascending: true });

    if (error) {
      throw error;
    }

    return data || [];
  }

  function findCurrentProfile(session, profiles) {
    if (!session || !session.user || !Array.isArray(profiles)) {
      return null;
    }

    const metadata = session.user.user_metadata || {};
    const appMetadata = session.user.app_metadata || {};
    const accountMemberId = metadata.rorc_account_member_id || appMetadata.rorc_account_member_id;
    const email = String(session.user.email || "").trim().toLowerCase();

    return (
      profiles.find((profile) => profile.account_member_id === accountMemberId)
      || profiles.find((profile) => String(profile.email_address || "").trim().toLowerCase() === email)
      || profiles[0]
      || null
    );
  }

  async function getCurrentMemberProfile() {
    const session = await getSession();

    if (!session) {
      return {
        session: null,
        profile: null,
        profiles: []
      };
    }

    const profiles = await getProfiles();

    return {
      session,
      profile: findCurrentProfile(session, profiles),
      profiles
    };
  }

  function cleanAuthUrl() {
    if (!window.history?.replaceState) {
      return;
    }

    window.history.replaceState({}, document.title, window.location.pathname);
  }

  function getInitialAuthParams() {
    return { ...initialAuthParams };
  }

  function getLastAuthEvent() {
    return lastAuthEvent;
  }

  function isRecoveryLink() {
    return initialAuthParams.type === "recovery" || lastAuthEvent === "PASSWORD_RECOVERY";
  }

  function onAuthEvent(callback) {
    authEventSubscribers.add(callback);
    return () => authEventSubscribers.delete(callback);
  }

  window.RORC_SUPABASE = {
    cleanAuthUrl,
    getClient,
    getCurrentMemberProfile,
    getInitialAuthParams,
    getLastAuthEvent,
    getProfiles,
    getSession,
    isRecoveryLink,
    onAuthEvent,
    url: SUPABASE_URL
  };
})();
