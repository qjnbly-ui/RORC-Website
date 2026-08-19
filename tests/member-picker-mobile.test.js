const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appSource = fs.readFileSync(path.resolve(__dirname, "..", "RORC App", "app.js"), "utf8");
const appStyles = fs.readFileSync(path.resolve(__dirname, "..", "RORC App", "app.css"), "utf8");

test("member picker Done completes on the first mobile interaction", () => {
  assert.match(appSource, /function bindMemberPickerCompletion/);
  assert.match(appSource, /doneButton\?\.addEventListener\("pointerdown", complete\)/);
  assert.match(appSource, /event\.key === "Enter" && hasSelection\(\)/);
  assert.match(appSource, /searchInput\?\.blur\(\)/);
  assert.match(appSource, /enterkeyhint="done"/);
  assert.match(appStyles, /\.member-picker-done\s*\{[^}]*touch-action:\s*manipulation/s);
});
