const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const dashboard = fs.readFileSync(require.resolve('../scripts/rorc-dashboard.js'), 'utf8');
const app = fs.readFileSync(require.resolve('../RORC App/app.js'), 'utf8');

test('confirmed rental dates stay on their saved day across time zones and daylight saving', () => {
  const source = dashboard.match(/function formatDate\(value\) \{[\s\S]*?\n  \}/)[0];
  for (const zone of ['America/Los_Angeles', 'UTC', 'Pacific/Auckland']) {
    const output = execFileSync(process.execPath, ['-e', `${source}; console.log(JSON.stringify(['2026-10-06','2026-10-08','2026-11-03','2027-03-16'].map(formatDate)))`], { env: { ...process.env, TZ: zone, LANG: 'en_US.UTF-8' } }).toString();
    assert.deepEqual(JSON.parse(output), ['Oct 6, 2026', 'Oct 8, 2026', 'Nov 3, 2026', 'Mar 16, 2027']);
  }
});

test('rental pipeline shows nearest upcoming rentals first and recent archive dates first', () => {
  const expression = app.match(/const all\s*= (\[\.\.\.rentalAllRequests\]\.sort\([\s\S]*?\n  \}\));/)[1];
  const rows = [
    {eventDate:'2027-05-27'}, {eventDate:'2026-09-01'}, {eventDate:'2026-10-08'},
    {eventDate:'2026-10-06',eventStartTime:'17:00'}, {eventDate:'2026-10-06',eventStartTime:'15:00'},
    {eventDate:'2026-09-30'}
  ];
  const result = vm.runInNewContext(expression, {rentalAllRequests:rows,isRentalPast:r=>r.eventDate<'2026-10-05'});
  assert.deepEqual(Array.from(result, r=>r.eventDate+(r.eventStartTime||'')), ['2026-10-0615:00','2026-10-0617:00','2026-10-08','2027-05-27','2026-09-30','2026-09-01']);
  assert.equal(rows[0].eventDate, '2027-05-27');
});

test('pending cancellation and change requests appear in Needs Action even on confirmed rentals', () => {
  const source = app.match(/function isRentalNeedsAction\(rental\) \{[\s\S]*?\n\}/)[0];
  const needsAction = vm.runInNewContext(`(${source})`);
  for (const requestType of ['cancel', 'change']) assert.equal(needsAction({rentalStatus:'confirmed',changeRequests:[{requestType,status:'pending'}]}),true);
  assert.equal(needsAction({rentalStatus:'confirmed',changeRequests:[{status:'approved'}]}),false);
});
