(function attachRorcResourceCoordinator(globalObject, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (globalObject) {
    globalObject.RORC_RESOURCE_COORDINATOR = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  function asVersion(value) {
    const version = Number(value);
    return Number.isSafeInteger(version) && version >= 0 ? version : 0;
  }

  function createResourceCoordinator({ now = () => Date.now(), onChange = () => {} } = {}) {
    const resources = new Map();

    function requireResource(name) {
      const resource = resources.get(name);
      if (!resource) throw new Error(`Unknown resource: ${name}`);
      return resource;
    }

    function notify(resource) {
      onChange(resource.name, getState(resource.name));
    }

    function register(name, { loader, ttlMs = 0 } = {}) {
      if (!name || typeof loader !== "function") {
        throw new TypeError("A resource name and loader are required.");
      }

      const existing = resources.get(name);
      const resource = existing || {
        name,
        status: "idle",
        fetchedAt: 0,
        inFlight: null,
        invalidated: true,
        error: null,
        data: undefined,
        hasValue: false,
        appliedVersion: 0,
        pendingVersion: 0,
        invalidationGeneration: 0,
        lifecycleGeneration: 0
      };
      resource.loader = loader;
      resource.ttlMs = Math.max(0, Number(ttlMs) || 0);
      resources.set(name, resource);
      return resource;
    }

    function getState(name) {
      const resource = requireResource(name);
      return {
        status: resource.status,
        fetchedAt: resource.fetchedAt,
        inFlight: resource.inFlight,
        invalidated: resource.invalidated,
        error: resource.error,
        data: resource.data,
        hasValue: resource.hasValue,
        appliedVersion: resource.appliedVersion,
        pendingVersion: resource.pendingVersion,
        ttlMs: resource.ttlMs
      };
    }

    function isFresh(resource) {
      if (!resource.hasValue || resource.invalidated || resource.status === "error") return false;
      return (now() - resource.fetchedAt) < resource.ttlMs;
    }

    function invalidate(name, { version } = {}) {
      const resource = requireResource(name);
      resource.invalidated = true;
      resource.invalidationGeneration += 1;
      resource.pendingVersion = Math.max(resource.pendingVersion, asVersion(version));
      notify(resource);
      return getState(name);
    }

    function ensure(name, { force = false, version } = {}) {
      const resource = requireResource(name);
      const requestedVersion = asVersion(version);
      if (requestedVersion > resource.appliedVersion) {
        resource.pendingVersion = Math.max(resource.pendingVersion, requestedVersion);
        resource.invalidated = true;
        resource.invalidationGeneration += 1;
      }

      if (resource.inFlight) return resource.inFlight;
      if (!force && requestedVersion <= resource.appliedVersion && isFresh(resource)) {
        return Promise.resolve(resource.data);
      }

      const lifecycleGeneration = resource.lifecycleGeneration;
      resource.inFlight = (async () => {
        do {
          const attemptGeneration = resource.invalidationGeneration;
          const targetVersion = resource.pendingVersion;
          resource.invalidated = false;
          resource.status = resource.hasValue ? "refreshing" : "loading";
          resource.error = null;
          notify(resource);

          try {
            const value = await resource.loader({
              name: resource.name,
              previousValue: resource.data,
              appliedVersion: resource.appliedVersion,
              targetVersion
            });
            if (resource.lifecycleGeneration !== lifecycleGeneration) return resource.data;
            resource.data = value;
            resource.hasValue = true;
            resource.fetchedAt = now();
            resource.appliedVersion = Math.max(resource.appliedVersion, targetVersion);
            resource.error = null;
            resource.status = "ready";
          } catch (error) {
            resource.error = error;
            resource.status = "error";
            resource.invalidated = true;
            notify(resource);
            throw error;
          }

          const changedDuringLoad = resource.invalidationGeneration !== attemptGeneration
            || resource.pendingVersion > targetVersion;
          resource.invalidated = changedDuringLoad;
          notify(resource);
        } while (resource.invalidated);

        return resource.data;
      })().finally(() => {
        if (resource.lifecycleGeneration !== lifecycleGeneration) return;
        resource.inFlight = null;
        notify(resource);
      });

      notify(resource);
      return resource.inFlight;
    }

    function clear() {
      resources.forEach((resource) => {
        resource.status = "idle";
        resource.fetchedAt = 0;
        resource.inFlight = null;
        resource.invalidated = true;
        resource.error = null;
        resource.data = undefined;
        resource.hasValue = false;
        resource.appliedVersion = 0;
        resource.pendingVersion = 0;
        resource.invalidationGeneration += 1;
        resource.lifecycleGeneration += 1;
        notify(resource);
      });
    }

    return { register, ensure, invalidate, getState, isFresh: (name) => isFresh(requireResource(name)), clear };
  }

  function createSyncController({
    scopes,
    fetchVersions,
    refreshScope,
    subscribe,
    documentRef = typeof document !== "undefined" ? document : null,
    windowRef = typeof window !== "undefined" ? window : null,
    intervalMs = 60_000,
    retryBaseMs = 1_000,
    retryMaxMs = 30_000,
    random = Math.random,
    setIntervalFn = typeof setInterval === "function" ? setInterval : null,
    clearIntervalFn = typeof clearInterval === "function" ? clearInterval : null,
    setTimeoutFn = typeof setTimeout === "function" ? setTimeout : null,
    clearTimeoutFn = typeof clearTimeout === "function" ? clearTimeout : null,
    onStateChange = () => {}
  } = {}) {
    if (!Array.isArray(scopes) || !scopes.length || typeof fetchVersions !== "function" || typeof refreshScope !== "function") {
      throw new TypeError("Sync scopes, fetchVersions, and refreshScope are required.");
    }

    const allowedScopes = new Set(scopes);
    const state = new Map(scopes.map((scope) => [scope, {
      appliedVersion: 0,
      pendingVersion: 0,
      inFlight: null,
      retryTimer: null,
      retryAttempt: 0,
      error: null
    }]));
    let started = false;
    let stopSubscription = null;
    let intervalId = null;
    let reconcileInFlight = null;
    let lifecycleGeneration = 0;

    function snapshot() {
      return Object.fromEntries([...state].map(([scope, item]) => [scope, {
        appliedVersion: item.appliedVersion,
        pendingVersion: item.pendingVersion,
        inFlight: item.inFlight,
        error: item.error
      }]));
    }

    function notify(status = "syncing") {
      onStateChange(status, snapshot());
    }

    function visible() {
      return !documentRef || documentRef.visibilityState !== "hidden";
    }

    function scheduleRetry(scope) {
      const item = state.get(scope);
      if (!started || item.retryTimer || !setTimeoutFn) return;
      const exponential = Math.min(retryMaxMs, retryBaseMs * (2 ** item.retryAttempt));
      const jitter = Math.floor(exponential * 0.25 * Math.max(0, Math.min(1, random())));
      item.retryAttempt += 1;
      item.retryTimer = setTimeoutFn(() => {
        item.retryTimer = null;
        requestScope(scope, item.pendingVersion).catch(() => {});
      }, exponential + jitter);
    }

    function requestScope(scope, version) {
      if (!allowedScopes.has(scope)) return Promise.resolve();
      const item = state.get(scope);
      item.pendingVersion = Math.max(item.pendingVersion, asVersion(version));
      if (item.inFlight) return item.inFlight;
      if (item.pendingVersion <= item.appliedVersion) return Promise.resolve();

      const requestGeneration = lifecycleGeneration;
      let trackedPromise;
      trackedPromise = (async () => {
        while (item.pendingVersion > item.appliedVersion) {
          const targetVersion = item.pendingVersion;
          try {
            await refreshScope(scope, targetVersion);
            if (!started || lifecycleGeneration !== requestGeneration) return;
            item.appliedVersion = Math.max(item.appliedVersion, targetVersion);
            item.retryAttempt = 0;
            item.error = null;
          } catch (error) {
            item.error = error;
            scheduleRetry(scope);
            throw error;
          }
        }
      })().finally(() => {
        if (item.inFlight === trackedPromise) item.inFlight = null;
        if (started && lifecycleGeneration === requestGeneration) {
          notify(item.error ? "delayed" : "live");
        }
      });
      item.inFlight = trackedPromise;

      notify("syncing");
      return item.inFlight;
    }

    function receiveInvalidation(payload) {
      const scope = String(payload?.scope || "");
      const version = asVersion(payload?.version);
      if (!allowedScopes.has(scope) || version < 1) return Promise.resolve();
      return requestScope(scope, version);
    }

    function reconcile() {
      if (!started) return Promise.resolve();
      if (reconcileInFlight) return reconcileInFlight;
      const reconcileGeneration = lifecycleGeneration;
      let trackedPromise;
      trackedPromise = Promise.resolve(fetchVersions())
        .then((rows) => {
          if (!started || lifecycleGeneration !== reconcileGeneration) return [];
          return Promise.all((Array.isArray(rows) ? rows : []).map((row) => (
            receiveInvalidation({ scope: row.scope, version: row.version })
          )));
        })
        .then(() => {
          if (started && lifecycleGeneration === reconcileGeneration) notify("live");
        })
        .catch((error) => {
          if (started && lifecycleGeneration === reconcileGeneration) notify("delayed");
          throw error;
        })
        .finally(() => {
          if (reconcileInFlight === trackedPromise) reconcileInFlight = null;
        });
      reconcileInFlight = trackedPromise;
      return reconcileInFlight;
    }

    const onVisibilityChange = () => {
      if (visible()) reconcile().catch(() => {});
    };
    const onOnline = () => reconcile().catch(() => {});
    const onOffline = () => notify("offline");
    const onPageShow = () => reconcile().catch(() => {});

    function start() {
      if (started) return;
      started = true;
      lifecycleGeneration += 1;
      documentRef?.addEventListener?.("visibilitychange", onVisibilityChange);
      windowRef?.addEventListener?.("online", onOnline);
      windowRef?.addEventListener?.("offline", onOffline);
      windowRef?.addEventListener?.("pageshow", onPageShow);
      if (setIntervalFn) {
        intervalId = setIntervalFn(() => {
          if (visible()) reconcile().catch(() => {});
        }, intervalMs);
      }
      if (typeof subscribe === "function") {
        stopSubscription = subscribe(receiveInvalidation, (status) => {
          if (status === "SUBSCRIBED") reconcile().catch(() => {});
        }) || null;
      }
      notify("syncing");
    }

    function stop() {
      if (!started) return;
      started = false;
      documentRef?.removeEventListener?.("visibilitychange", onVisibilityChange);
      windowRef?.removeEventListener?.("online", onOnline);
      windowRef?.removeEventListener?.("offline", onOffline);
      windowRef?.removeEventListener?.("pageshow", onPageShow);
      lifecycleGeneration += 1;
      if (intervalId !== null && clearIntervalFn) clearIntervalFn(intervalId);
      intervalId = null;
      if (typeof stopSubscription === "function") stopSubscription();
      stopSubscription = null;
      reconcileInFlight = null;
      state.forEach((item) => {
        if (item.retryTimer && clearTimeoutFn) clearTimeoutFn(item.retryTimer);
        item.retryTimer = null;
        item.inFlight = null;
      });
      notify("stopped");
    }

    return { start, stop, reconcile, receiveInvalidation, requestScope, getState: snapshot, isStarted: () => started };
  }

  return { createResourceCoordinator, createSyncController };
});
