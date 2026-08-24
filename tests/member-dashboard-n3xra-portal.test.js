const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dashboardHtml = fs.readFileSync(path.join(root, "member-dashboard/index.html"), "utf8");
const dashboardScript = fs.readFileSync(path.join(root, "scripts/rorc-dashboard.js"), "utf8");

test("member dashboard includes the Ruth Obenchain N3XRA portal shortcut", () => {
  assert.match(dashboardHtml, /id="openN3xraPortalBtn"/);
  assert.match(
    dashboardHtml,
    /href="https:\/\/ruth-obenchain-recreation-center\.portal\.n3xra\.com\/"/
  );
  assert.match(dashboardHtml, /id="openN3xraPortalBtn"[\s\S]*?hidden/);
});

test("N3XRA portal shortcut is restricted to Quentin's verified manager profile", () => {
  assert.match(dashboardScript, /email: "qjnbly@hotmail\.com"/);
  assert.match(dashboardScript, /accountNumber: "1"/);
  assert.match(dashboardScript, /isAccountManager\(profile\)/);
  assert.match(dashboardScript, /signedInEmail === N3XRA_PORTAL_ACCOUNT\.email/);
  assert.match(dashboardScript, /profileEmail === N3XRA_PORTAL_ACCOUNT\.email/);
  assert.match(dashboardScript, /portalButton\.hidden = !canOpenN3xraPortal\(\)/);
});
