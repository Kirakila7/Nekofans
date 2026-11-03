'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { snapFloatingBounds: snap } = require('../../apps/neko-workbench/floating-window-snap.cjs');
const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
const bounds = { x: 500, y: 400, width: 480, height: 120 };

test('screen edges and corners snap within 20 DIP, distant placements and sizes stay unchanged', () => {
  for (const [x, y, expectedX, expectedY] of [[20, 400, 8, 400], [1420, 400, 1432, 400], [500, 20, 500, 8], [500, 940, 500, 952], [20, 940, 8, 952]]) {
    assert.deepEqual(snap({ ...bounds, x, y }, { workArea }), { ...bounds, x: expectedX, y: expectedY });
  }
  assert.deepEqual(snap(bounds, { workArea }), bounds);
  assert.equal(snap({ ...bounds, x: 28 }, { workArea }).x, 8);
  assert.equal(snap({ ...bounds, x: 29 }, { workArea }).x, 29);
});

test('nearest valid screen or owner edge wins without pulling an unrelated or oversized window', () => {
  const ownerBounds = { x: 100, y: 100, width: 1000, height: 800 };
  assert.deepEqual(snap({ ...bounds, x: 115, y: 770 }, { workArea, ownerBounds }), { ...bounds, x: 108, y: 772 });
  assert.equal(snap({ ...bounds, x: 115, y: 950 }, { workArea, ownerBounds }).x, 115);
  assert.equal(snap({ ...bounds, x: 115 }, { workArea, ownerBounds: { ...ownerBounds, width: 300 } }).x, 115);
  assert.equal(snap({ ...bounds, x: 15 }, { workArea, ownerBounds: { ...ownerBounds, x: 10 } }).x, 18);
  assert.equal(snap({ ...bounds, x: 500 }, { workArea, ownerBounds: { ...ownerBounds, x: -492 } }).x, 500, 'off-screen owner target is ignored');
});

test('negative-origin displays and missing owners use DIP bounds without changing the original object', () => {
  const input = { x: -1910, y: -190, width: 480, height: 336 };
  const area = { x: -1920, y: -200, width: 1920, height: 1080 };
  assert.deepEqual(snap(input, { workArea: area }), { ...input, x: -1912, y: -192 });
  assert.deepEqual(input, { x: -1910, y: -190, width: 480, height: 336 });
  assert.deepEqual(snap(input), input);
  assert.throws(() => snap({ ...input, width: NaN }));
});
