(function() {
  if (window.RORC_SUPABASE) {
    return;
  }

  const SUPABASE_URL = "https://aedvuofiodtsgijcxyqx.supabase.co";
  const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_lNxmEUnsIUXeoAe9MLp0BA_QInzqALY";
  const SUPABASE_SDK_URL = "/RORC%20App/vendor/supabase.min.js?v=2.112.2";
  const initialAuthParams = readAuthParams();

  let activeMemberId = "";
  let activeUserId = "";
  let accountChoices = [];

  function scopedFetch(input, options = {}) {
    const headers = new Headers(options.headers || (input instanceof Request ? input.headers : undefined));
    const destination = new URL(input instanceof Request ? input.url : input, window.location.origin);
    if (activeMemberId && (destination.origin === window.location.origin || destination.origin === SUPABASE_URL)) headers.set("x-rorc-account-member", activeMemberId);
    return window.fetch(input, {...options, headers});
  }

  function chooseAccount(memberId) {
    if (!accountChoices.some(choice => choice.account_member_id === memberId)) throw new Error("Account access required.");
    activeMemberId = memberId;
    try { window.localStorage.setItem(`rorc-account:${activeUserId}`, memberId); } catch (_) {}
  }

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
        global: {fetch: scopedFetch},
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
        if (event === "SIGNED_OUT") { activeMemberId = ""; activeUserId = ""; accountChoices = []; }
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

  async function getCurrentMemberProfile() {
    const session = await getSession();

    if (!session) {
      return {
        session: null,
        profile: null,
        profiles: []
      };
    }

    const client = await getClient();
    const {data: choices, error} = await client.rpc("list_my_accounts");
    if (error) throw error;
    accountChoices = choices || [];
    activeUserId = session.user.id;
    let saved = "";
    try { saved = window.localStorage.getItem(`rorc-account:${activeUserId}`) || ""; } catch (_) {}
    const selected = accountChoices.find(choice => choice.account_member_id === saved) || accountChoices.find(choice => choice.is_primary) || accountChoices[0];
    activeMemberId = selected?.account_member_id || "";
    const profiles = await getProfiles();
    return {
      session,
      profile: profiles.find(profile => profile.account_member_id === activeMemberId) || null,
      profiles,
      accounts: accountChoices,
      isPrimaryAccount: Boolean(selected?.is_primary)
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
    chooseAccount,
    scopedFetch,
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
