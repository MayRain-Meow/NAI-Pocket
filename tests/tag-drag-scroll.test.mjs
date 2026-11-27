import assert from 'node:assert/strict';
import { tagDragEdgeSpeed, tagDragScrollStep } from '../public/tag-drag-scroll.js';

for (const y of [137, 200, 400, 600, 663]) assert.equal(tagDragEdgeSpeed(y, 100, 700), 0);
assert.equal(tagDragEdgeSpeed(100, 100, 700), -420);
assert.equal(tagDragEdgeSpeed(700, 100, 700), 420);
assert.equal(tagDragEdgeSpeed(-50, 100, 700), -420);
assert.equal(tagDragEdgeSpeed(500, 480, 500), 0, 'no usable space means no scroll');
function distance(fps) {
  const state = {};
  let total = 0;
  for (let time = 0; time <= 1000; time += 1000 / fps) total += tagDragScrollStep(state, 420, time);
  return total;
}
assert.ok(Math.abs(distance(60) - distance(120)) < 10, 'refresh rate does not double speed');
const state = {};
assert.equal(tagDragScrollStep(state, 420, 0), 0);
assert.equal(tagDragScrollStep(state, 420, 150), 0, 'brief edge visits never scroll');
assert.ok(tagDragScrollStep(state, 420, 300) > 0);
assert.equal(tagDragScrollStep(state, -420, 310), 0, 'changing direction restarts dwell');
assert.equal(tagDragScrollStep(state, 0, 320), 0, 'center immediately stops scrolling');
assert.equal(tagDragScrollStep(state, -420, 700), 0, 'returning to edge requires a new dwell');
console.log('tag drag scroll: narrow bands, dwell, gradual ramp, stops and 60/120 Hz equivalence passed');
