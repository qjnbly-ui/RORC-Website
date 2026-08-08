const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "RORC App", "app.js"), "utf8");
const appHtml = fs.readFileSync(path.join(root, "RORC App", "index.html"), "utf8");

function topLevelFunctionSource(name) {
  const declaration = new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, "m");
  const match = declaration.exec(appSource);
  assert.ok(match, `Expected app.js to declare ${name}().`);

  const remaining = appSource.slice(match.index + match[0].length);
  const nextFunction = /\n(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/.exec(remaining);
  return appSource.slice(
    match.index,
    nextFunction ? match.index + match[0].length + nextFunction.index : appSource.length
  );
}

function enclosingTopLevelFunction(offset) {
  const declarations = [...appSource.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)]
    .filter((match) => match.index < offset);
  return declarations.at(-1)?.[1] || "";
}

function callSites(functionName) {
  const declarationPattern = new RegExp(`^(?:async\\s+)?function\\s+${functionName}\\s*\\(`, "gm");
  const declarationOffsets = new Set([...appSource.matchAll(declarationPattern)].map((match) => (
    match.index + match[0].lastIndexOf(functionName)
  )));
  const callPattern = new RegExp(`\\b${functionName}\\s*\\(`, "g");

  return [...appSource.matchAll(callPattern)]
    .filter((match) => !declarationOffsets.has(match.index))
    .map((match) => ({
      offset: match.index,
      owner: enclosingTopLevelFunction(match.index)
    }));
}

function occurrences(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

test("startup hydration loads identity and active-route data without eager feature metadata", () => {
  const hydrate = topLevelFunctionSource("hydrateFromSupabase");

  assert.match(hydrate, /await ensureResource\("identity",\s*\{\s*force:\s*true\s*\}\)/);
  assert.match(hydrate, /await ensureRouteResources\(appState\.currentRoute\)/);
  assert.match(hydrate, /startRealtimeSyncController\(\)/);
  assert.doesNotMatch(hydrate, /legacyHydrateFromSupabase|syncStripeMembershipForProfile/);
  assert.doesNotMatch(hydrate, /refreshMessageHistory|messageHistory/);
  assert.doesNotMatch(hydrate, /refreshContractReviewBadge|refreshRentalReviewsBadge|refreshSponsorSubmissionsBadge|managerBadges/);
  assert.doesNotMatch(hydrate, /fetchThermostatStatus|loadThermostatSystemAccess|thermostat(?:Status|Settings)/);
  assert.doesNotMatch(hydrate, /refreshOwnedCalendarEventAvailability|calendar(?:Events|EventRequests|FacilityBlocks)/);
});

test("kiosk Currently Signed In startup is bounded to four browser data requests", () => {
  const identity = topLevelFunctionSource("loadIdentityResource");
  const attendance = topLevelFunctionSource("loadAttendanceResource");
  const privilegedAttendance = topLevelFunctionSource("fetchPrivilegedTimesheetEntries");
  const directory = topLevelFunctionSource("loadGlobalMemberDirectory");
  const routeResources = topLevelFunctionSource("routeResourceNames");
  const registrations = topLevelFunctionSource("registerAppResources");

  assert.equal(occurrences(identity, /\.from\(/g), 2);
  assert.match(identity, /\.from\("account_member_profiles"\)/);
  assert.match(identity, /\.from\("account_type_permissions"\)/);
  assert.doesNotMatch(identity, /\bfetch\s*\(/);

  assert.match(
    routeResources,
    /if \(routeName === "currentlySignedIn"\)\s*\{\s*return \["attendanceOpen",\s*isKioskAccount\(appUserSession\) \? "directory" : ""\];\s*\}/
  );
  assert.match(registrations, /register\("attendanceOpen",\s*\{[^}]*loader:\s*\(\) => loadAttendanceResource\("open"\)/);
  assert.match(registrations, /register\("directory",\s*\{[^}]*loader:\s*loadGlobalMemberDirectory/);
  assert.match(attendance, /if \(canUsePrivilegedTimesheetApi\(\)\)\s*\{\s*rows = await fetchPrivilegedTimesheetEntries\(viewName === "history" \? "" : viewName\)/);
  assert.equal(occurrences(privilegedAttendance, /\bfetch\s*\(/g), 1);
  assert.match(privilegedAttendance, /query\.set\("view",\s*viewName\)/);
  assert.equal(occurrences(directory, /\bfetch\s*\(/g), 1);
  assert.match(directory, /fetch\("\/api\/member-directory"/);

  const browserDataRequestCount = occurrences(identity, /\.from\(/g)
    + occurrences(privilegedAttendance, /\bfetch\s*\(/g)
    + occurrences(directory, /\bfetch\s*\(/g);
  assert.equal(browserDataRequestCount, 4);
});

test("a failed directory refresh cannot replace previously loaded client data", () => {
  const directory = topLevelFunctionSource("loadGlobalMemberDirectory");
  const responseGuard = directory.indexOf("if (!response.ok || body.success === false)");
  const directoryAssignment = directory.indexOf("globalMemberDirectory = rows.map");

  assert.ok(responseGuard >= 0, "Expected directory responses to be validated.");
  assert.ok(directoryAssignment > responseGuard, "Directory data must only be replaced after a successful response.");
  assert.match(directory.slice(responseGuard, directoryAssignment), /throw new Error\(/);
});

test("full hydration is auth-bound and is never used as a post-save refresh", () => {
  const hydrateOwners = callSites("hydrateFromSupabase").map(({ owner }) => owner).sort();

  assert.deepEqual(hydrateOwners, ["handlePasswordLogin", "initApp"]);
  assert.equal(
    hydrateOwners.some((name) => /save|submit|create|update|delete|invite|turn|change/i.test(name)),
    false
  );
  assert.match(appSource, /async function refreshTargetedResources\(/);
});

test("Twilio Voice remains absent from startup and loads only on the communications call route", () => {
  const hydrate = topLevelFunctionSource("hydrateFromSupabase");
  const communications = topLevelFunctionSource("renderCommunicationsPage");
  const twilioOwners = callSites("loadTwilioVoiceSdk").map(({ owner }) => owner).sort();

  assert.doesNotMatch(appHtml, /twilio-voice\.min\.js/i);
  assert.doesNotMatch(hydrate, /loadTwilioVoiceSdk|twilio-voice\.min\.js/i);
  assert.deepEqual(twilioOwners, ["renderCommunicationsPage", "startOutboundCommunicationCall"]);
  assert.match(appSource, /communications:\s*\{[^}]*afterRender:\s*renderCommunicationsPage/s);
  assert.match(communications, /if \(messagesActive\)[\s\S]*?else\s*\{[\s\S]*?loadTwilioVoiceSdk\(\)/);
});
