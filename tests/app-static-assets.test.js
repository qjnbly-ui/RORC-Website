const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const appDirectory = path.join(root, "RORC App");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("Supabase browser SDK is pinned and its committed assets are reproducible", () => {
  const packageJson = JSON.parse(read("package.json"));
  const packageLock = JSON.parse(read("package-lock.json"));
  const version = packageJson.dependencies["@supabase/supabase-js"];

  assert.equal(version, "2.112.2");
  assert.equal(packageLock.packages[""].dependencies["@supabase/supabase-js"], version);
  assert.equal(packageLock.packages["node_modules/@supabase/supabase-js"].version, version);
  assert.deepEqual(
    fs.readFileSync(path.join(appDirectory, "vendor", "supabase.min.js")),
    fs.readFileSync(path.join(root, "node_modules", "@supabase", "supabase-js", "dist", "umd", "supabase.js"))
  );
  assert.deepEqual(
    fs.readFileSync(path.join(appDirectory, "vendor", "SUPABASE-JS-LICENSE")),
    fs.readFileSync(path.join(root, "node_modules", "@supabase", "supabase-js", "LICENSE"))
  );
});

test("app shell self-hosts Supabase, loads its coordinator first, and lazy-loads Twilio", () => {
  const html = read("RORC App/index.html");
  const appSource = read("RORC App/app.js");
  const supabaseSdk = html.indexOf("./vendor/supabase.min.js?v=2.112.2");
  const supabaseWrapper = html.indexOf("/scripts/rorc-supabase-client.js?v=20260808-realtime-stability");
  const coordinator = html.indexOf("./resource-coordinator.js?v=20260808-reliable-sync");
  const app = html.indexOf("./app.js?v=20260808-reliable-sync");

  assert.ok(supabaseSdk >= 0);
  assert.ok(supabaseSdk < supabaseWrapper);
  assert.ok(supabaseWrapper < coordinator);
  assert.ok(coordinator < app);
  assert.doesNotMatch(html, /twilio-voice\.min\.js/i);
  assert.match(appSource, /function loadTwilioVoiceSdk\(\)/);
  assert.match(appSource, /\/RORC%20App\/vendor\/twilio-voice\.min\.js\?v=2\.18\.3/);
});

test("Supabase wrapper uses the modern publishable key and resilient heartbeat options", () => {
  const source = read("scripts/rorc-supabase-client.js");

  assert.match(source, /SUPABASE_PUBLISHABLE_KEY\s*=\s*"sb_publishable_[^"]+"/);
  assert.doesNotMatch(source, /SUPABASE_ANON_KEY|cdn\.jsdelivr\.net/);
  assert.match(source, /SUPABASE_SDK_URL\s*=\s*"\/RORC%20App\/vendor\/supabase\.min\.js\?v=2\.112\.2"/);
  assert.match(source, /worker:\s*true/);
  assert.match(source, /heartbeatIntervalMs:\s*15000/);
  assert.match(source, /heartbeatCallback:\s*handleHeartbeat/);
  assert.match(source, /client\.realtime\.connect\(\)/);
});

test("heartbeat failures schedule one guarded Realtime recovery", async () => {
  const source = read("scripts/rorc-supabase-client.js");
  const timers = [];
  let connectCount = 0;
  let capturedOptions;
  let capturedKey = "";
  const client = {
    auth: { onAuthStateChange() {} },
    realtime: {
      isConnected: () => false,
      connect: () => { connectCount += 1; }
    }
  };
  const windowRef = {
    location: { search: "", hash: "", origin: "https://example.test", pathname: "/RORC%20App/" },
    history: { replaceState() {} },
    supabase: {
      createClient(url, key, options) {
        assert.equal(url, "https://aedvuofiodtsgijcxyqx.supabase.co");
        capturedKey = key;
        capturedOptions = options;
        return client;
      }
    },
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    }
  };

  vm.runInNewContext(source, {
    window: windowRef,
    document: { title: "RORC App" },
    URL,
    URLSearchParams
  });

  assert.equal(await windowRef.RORC_SUPABASE.getClient(), client);
  assert.match(capturedKey, /^sb_publishable_/);
  assert.equal(capturedOptions.realtime.worker, true);
  capturedOptions.realtime.heartbeatCallback("timeout");
  capturedOptions.realtime.heartbeatCallback("error");
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 1000);
  timers[0].callback();
  assert.equal(connectCount, 1);
});

test("service worker caches only versioned static assets and performs one update handoff", () => {
  const source = read("RORC App/sw.js");
  const html = read("RORC App/index.html");
  const appSource = read("RORC App/app.js");
  const version = Number(source.match(/CACHE_VERSION\s*=\s*"rorc-app-v(\d+)"/)?.[1]);
  const versionedAssets = [...html.matchAll(/(?:src|href)="([^"]+\?v=[^"]+)"/g)]
    .map((match) => match[1]);

  assert.ok(version > 66);
  assert.doesNotMatch(source, /app\.config\.js|twilio-voice\.min\.js/);
  versionedAssets.forEach((asset) => assert.match(source, new RegExp(asset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))));
  assert.match(source, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(source, /request\.headers\.has\("authorization"\)/);
  assert.match(source, /isVersionedStaticRequest/);
  assert.match(source, /staleWhileRevalidateNavigation/);
  assert.doesNotMatch(source, /client\.navigate|RORC_APP_UPDATED|postMessage\(/);
  assert.equal((appSource.match(/addEventListener\("controllerchange"/g) || []).length, 1);
  assert.match(appSource, /if \(appReloadingForUpdate\) return;/);
});

test("Vercel builds all generated assets and applies explicit static cache headers", () => {
  const config = JSON.parse(read("vercel.json"));
  assert.equal(config.buildCommand, "npm run vercel-build");

  const versionedApp = config.headers.find((rule) => rule.source === "/RORC App/(.*)" && rule.has?.[0]?.key === "v");
  const versionedScripts = config.headers.find((rule) => rule.source === "/scripts/(.*)" && rule.has?.[0]?.key === "v");
  const indexHeader = config.headers.find((rule) => rule.source === "/RORC App/index.html");
  const workerHeader = config.headers.find((rule) => rule.source === "/RORC App/sw.js");

  assert.equal(versionedApp.headers[0].value, "public, max-age=31536000, immutable");
  assert.equal(versionedScripts.headers[0].value, "public, max-age=31536000, immutable");
  assert.equal(indexHeader.headers[0].value, "public, max-age=0, must-revalidate");
  assert.equal(workerHeader.headers[0].value, "public, max-age=0, must-revalidate");
});
