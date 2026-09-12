const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const appSource = fs.readFileSync(path.resolve(__dirname, "..", "RORC App", "app.js"), "utf8");
const appStyles = fs.readFileSync(path.resolve(__dirname, "..", "RORC App", "app.css"), "utf8");

function setup() {
  const source = appSource.slice(appSource.indexOf("function bindMemberPickerCompletion("), appSource.indexOf("\nfunction openMemberPicker("));
  const context = {};
  vm.runInNewContext(source, context);
  const button = new EventTarget();
  const search = new EventTarget();
  let closes = 0;
  let blurs = 0;
  search.blur = () => blurs++;
  context.bindMemberPickerCompletion({ doneButton: button, searchInput: search, close: () => closes++, hasSelection: () => true });
  return { button, search, counts: () => ({ closes, blurs }) };
}

test("Done keeps the overlay through pointer down and closes on click", () => {
  const { button, counts } = setup();
  const down = new Event("pointerdown", { cancelable: true });
  button.dispatchEvent(down);
  assert.equal(down.defaultPrevented, true);
  assert.deepEqual(counts(), { closes: 0, blurs: 0 });
  button.dispatchEvent(new Event("pointerup"));
  assert.equal(counts().closes, 0);
  button.dispatchEvent(new Event("click", { cancelable: true }));
  assert.deepEqual(counts(), { closes: 1, blurs: 1 });
});

test("canceling a touch leaves the picker open", () => {
  const { button, counts } = setup();
  button.dispatchEvent(new Event("pointerdown", { cancelable: true }));
  button.dispatchEvent(new Event("pointercancel"));
  assert.equal(counts().closes, 0);
});

test("Done supports keyboard clicks and search Enter", () => {
  const click = setup();
  click.button.dispatchEvent(new Event("click"));
  assert.equal(click.counts().closes, 1);
  const enter = setup();
  const event = new Event("keydown", { cancelable: true });
  event.key = "Enter";
  enter.search.dispatchEvent(event);
  assert.equal(enter.counts().closes, 1);
  assert.match(appSource, /enterkeyhint="done"/);
  assert.match(appStyles, /\.member-picker-done\s*\{[^}]*touch-action:\s*manipulation/s);
});
