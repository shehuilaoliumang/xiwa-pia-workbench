// Verify the production phase scheduler with synthetic monitor refresh rates.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../static/display.js'), 'utf8');
const section = source.slice(source.indexOf('  function createMotionScheduler()'), source.indexOf('  // END MOTION SCHEDULER'));
const create = vm.runInNewContext(section + '\ncreateMotionScheduler');
let cases = 0;
for (const refresh of [30, 60, 90, 120, 144, 240]) {
  for (const target of [10, 30, 60, 90, 120]) {
    const scheduler = create(); let count = 0;
    for (let i = 0; i < refresh * 10; i++) count += scheduler.due(i * 1000 / refresh, target);
    assert(Math.abs(count - Math.min(refresh, target) * 10) <= 1, `${target} Hz at ${refresh} Hz: ${count}`);
    cases++;
  }
}
const scheduler = create();
assert(scheduler.due(0, 90));
assert(!scheduler.due(1, 90));
assert(scheduler.due(5000, 90));
assert(!scheduler.due(5000, 90), 'no burst after a suspended frame');
assert(!scheduler.due(5001, 90));
assert(scheduler.due(5002, 90, true), 'interaction can send immediately');
assert(!scheduler.due(5003, 90));
assert(scheduler.due(5004, 30), 'changing target begins a fresh phase');
assert(!scheduler.due(5005, 30));
scheduler.reset(); assert(scheduler.due(5006, 120));
assert(!scheduler.due(NaN, 120));
assert(!scheduler.due(5007, 0));
console.log(`Sync phase scheduler passed: ${cases} refresh/target combinations, stall, forced event, rate change.`);
