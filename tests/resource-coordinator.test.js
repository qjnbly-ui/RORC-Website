const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createResourceCoordinator,
  createSyncController
} = require("../RORC App/resource-coordinator.js");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("resource coordinator deduplicates requests and honors TTLs", async () => {
  let now = 1_000;
  let calls = 0;
  const first = deferred();
  const coordinator = createResourceCoordinator({ now: () => now });
  coordinator.register("attendance", {
    ttlMs: 15_000,
    loader: () => {
      calls += 1;
      return first.promise;
    }
  });

  const one = coordinator.ensure("attendance");
  const two = coordinator.ensure("attendance");
  assert.equal(one, two);
  assert.equal(calls, 1);

  first.resolve(["open-entry"]);
  assert.deepEqual(await one, ["open-entry"]);
  assert.equal(coordinator.getState("attendance").status, "ready");

  now += 14_999;
  assert.deepEqual(await coordinator.ensure("attendance"), ["open-entry"]);
  assert.equal(calls, 1);
});

test("invalidation during a refresh performs one follow-up and applies the newest version", async () => {
  const loads = [];
  const coordinator = createResourceCoordinator();
  coordinator.register("directory", {
    ttlMs: 300_000,
    loader: ({ targetVersion }) => {
      const pending = deferred();
      loads.push({ targetVersion, pending });
      return pending.promise;
    }
  });

  coordinator.invalidate("directory", { version: 2 });
  const refresh = coordinator.ensure("directory", { version: 2 });
  const shared = coordinator.ensure("directory", { version: 3 });
  assert.equal(shared, refresh);
  assert.equal(loads.length, 1);

  loads[0].pending.resolve("version-2");
  await flush();
  assert.equal(loads.length, 2);
  assert.equal(loads[1].targetVersion, 3);
  loads[1].pending.resolve("version-3");

  assert.equal(await refresh, "version-3");
  const state = coordinator.getState("directory");
  assert.equal(state.appliedVersion, 3);
  assert.equal(state.invalidated, false);
});

test("failed refresh keeps prior data and version retryable", async () => {
  let shouldFail = false;
  const coordinator = createResourceCoordinator();
  coordinator.register("heater", {
    ttlMs: 15_000,
    loader: async () => {
      if (shouldFail) throw new Error("offline");
      return ["existing-record"];
    }
  });

  await coordinator.ensure("heater", { version: 1 });
  shouldFail = true;
  coordinator.invalidate("heater", { version: 2 });
  await assert.rejects(coordinator.ensure("heater", { version: 2 }), /offline/);

  const state = coordinator.getState("heater");
  assert.deepEqual(state.data, ["existing-record"]);
  assert.equal(state.appliedVersion, 1);
  assert.equal(state.invalidated, true);
  assert.equal(state.status, "error");
});

test("clearing while a request is in flight cannot repopulate signed-out data", async () => {
  const pending = deferred();
  const coordinator = createResourceCoordinator();
  coordinator.register("private-profile", {
    ttlMs: 300_000,
    loader: () => pending.promise
  });

  const request = coordinator.ensure("private-profile");
  coordinator.clear();
  pending.resolve({ name: "Private Member" });
  assert.equal(await request, undefined);

  const state = coordinator.getState("private-profile");
  assert.equal(state.hasValue, false);
  assert.equal(state.data, undefined);
  assert.equal(state.status, "idle");
});

class FakeEventTarget {
  constructor() {
    this.visibilityState = "visible";
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type) {
    this.listeners.get(type)?.forEach((listener) => listener());
  }

  count(type) {
    return this.listeners.get(type)?.size || 0;
  }
}

test("sync controller coalesces wake checks, event bursts, and cleans up listeners", async () => {
  const documentRef = new FakeEventTarget();
  const windowRef = new FakeEventTarget();
  const versionFetch = deferred();
  const refreshes = [];
  let fetchCount = 0;
  let invalidateHandler;
  let statusHandler;
  let unsubscribeCount = 0;
  let intervalCallback;
  let intervalCleared = 0;
  const statuses = [];

  const controller = createSyncController({
    scopes: ["attendance"],
    documentRef,
    windowRef,
    fetchVersions: () => {
      fetchCount += 1;
      return versionFetch.promise;
    },
    refreshScope: (scope, version) => {
      const pending = deferred();
      refreshes.push({ scope, version, pending });
      return pending.promise;
    },
    subscribe: (onInvalidate, onStatus) => {
      invalidateHandler = onInvalidate;
      statusHandler = onStatus;
      return () => { unsubscribeCount += 1; };
    },
    setIntervalFn: (callback) => {
      intervalCallback = callback;
      return 77;
    },
    clearIntervalFn: (id) => {
      assert.equal(id, 77);
      intervalCleared += 1;
    },
    onStateChange: (status) => statuses.push(status)
  });

  controller.start();
  controller.start();
  assert.equal(documentRef.count("visibilitychange"), 1);
  assert.equal(windowRef.count("online"), 1);
  assert.equal(windowRef.count("offline"), 1);
  assert.equal(windowRef.count("pageshow"), 1);

  statusHandler("SUBSCRIBED");
  documentRef.dispatch("visibilitychange");
  windowRef.dispatch("online");
  windowRef.dispatch("pageshow");
  intervalCallback();
  assert.equal(fetchCount, 1);

  versionFetch.resolve([{ scope: "attendance", version: 1 }]);
  await flush();
  assert.equal(refreshes.length, 1);
  refreshes[0].pending.resolve();
  await flush();
  assert.ok(statuses.includes("live"));

  windowRef.dispatch("offline");
  assert.equal(statuses.at(-1), "offline");

  const burst = invalidateHandler({ scope: "attendance", version: 2 });
  invalidateHandler({ scope: "attendance", version: 3 });
  invalidateHandler({ scope: "attendance", version: 3 });
  assert.equal(refreshes.length, 2);
  refreshes[1].pending.resolve();
  await flush();
  assert.equal(refreshes.length, 3);
  assert.equal(refreshes[2].version, 3);
  refreshes[2].pending.resolve();
  await burst;

  controller.stop();
  assert.equal(documentRef.count("visibilitychange"), 0);
  assert.equal(windowRef.count("online"), 0);
  assert.equal(windowRef.count("offline"), 0);
  assert.equal(windowRef.count("pageshow"), 0);
  assert.equal(unsubscribeCount, 1);
  assert.equal(intervalCleared, 1);
});
