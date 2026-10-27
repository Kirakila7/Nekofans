import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { fitPetBounds, matchingWorkArea, managePetGeometry, type Rectangle } from "../../packages/app-coordinator/src/window-geometry.ts";

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const left = { x: -1280, y: -200, width: 1280, height: 900 };
const size = { width: 420, height: 640 };
function fixture(initial: Rectangle = { x: 1400, y: 350, ...size }) {
  let areas = [primary, left];
  let cursor = { x: 1500, y: 800 };
  let current = { ...initial }, destroyed = false;
  const zooms: number[] = [], writes: Rectangle[] = [];
  const screen = Object.assign(new EventEmitter(), {
    getPrimaryDisplay: () => ({ workArea: areas[0] }),
    getAllDisplays: () => areas.map((workArea) => ({ workArea })),
    getCursorScreenPoint: () => cursor,
  });
  const win = {
    isDestroyed: () => destroyed, getPosition: () => [current.x, current.y],
    getBounds: () => ({ ...current }),
    setPosition: (x: number, y: number) => { current = { ...current, x, y }; },
    setBounds: (bounds: Rectangle) => { current = { ...bounds }; writes.push(bounds); },
    webContents: { setZoomFactor: (zoom: number) => { zooms.push(zoom); } },
  };
  const geometry = managePetGeometry(win, screen, size);
  return { geometry, screen, zooms, writes, bounds: () => current,
    cursor: (point: typeof cursor) => { cursor = point; },
    areas: (next: Rectangle[]) => { areas = next; }, destroy: () => { destroyed = true; },
  };
}

test("pet bounds choose real work areas including negative origins and monitor gaps", () => {
  assert.deepEqual(matchingWorkArea({ x: -1100, y: -150, ...size }, [primary, left]), left);
  const separated = { x: 2400, y: 300, width: 1280, height: 900 };
  assert.deepEqual(matchingWorkArea({ x: 2050, y: 350, ...size }, [primary, separated], { x: 2200, y: 800 }), separated);
  assert.deepEqual(fitPetBounds({ x: -9999, y: 9999 }, size, left).bounds,
    { x: -1280, y: 60, width: 420, height: 640 });
});

test("DIP cursor controls cross-monitor dragging; renderer coordinates cannot multiply physical DPI", () => {
  const f = fixture();
  // A renderer in a differently scaled screen may report entirely different coordinates.
  f.geometry.begin({ x: 3000, y: 1600 });
  f.cursor({ x: -700, y: 300 });
  f.geometry.move({ x: -1400, y: 600 });
  assert.deepEqual(f.bounds(), { x: -800, y: -150, ...size });
  f.cursor({ x: -2000, y: -1000 });
  f.geometry.move({ x: 0, y: 0 });
  assert.deepEqual(f.bounds(), { x: -1280, y: -200, ...size });
  f.geometry.end();
  f.cursor({ x: 500, y: 600 }); f.geometry.move({ x: 500, y: 600 });
  assert.equal(f.bounds().x, -1280, "move without an active drag is ignored");
  f.geometry.dispose();
});

test("display removal recovers onto a connected monitor and discards the previous drag anchor", () => {
  const f = fixture({ x: -1100, y: -100, ...size });
  f.cursor({ x: -900, y: 0 }); f.geometry.begin({ x: 0, y: 0 });
  f.areas([primary]); f.screen.emit("display-removed");
  assert.deepEqual(f.bounds(), { x: 0, y: 0, ...size });
  const count = f.writes.length;
  f.geometry.move({ x: -900, y: 0 }); assert.equal(f.writes.length, count);
  f.geometry.dispose();
});

test("small work areas scale the entire UI and restore original DIP size when space returns", () => {
  const f = fixture();
  f.areas([{ x: 0, y: 30, width: 800, height: 480 }]); f.screen.emit("display-metrics-changed");
  assert.deepEqual(f.bounds(), { x: 485, y: 30, width: 315, height: 480 });
  assert.deepEqual(f.zooms, [1, 0.75]);
  f.areas([primary]); f.screen.emit("display-metrics-changed");
  assert.deepEqual(f.bounds(), { x: 485, y: 30, ...size });
  assert.deepEqual(f.zooms, [1, 0.75, 1]);
  f.geometry.dispose();
});

test("each window's zoom is independent, with no display listeners or writes after disposal", () => {
  const first = fixture(), second = fixture();
  first.areas([{ x: 0, y: 0, width: 800, height: 320 }]); first.screen.emit("display-metrics-changed");
  assert.deepEqual(first.zooms, [1, 0.5]); assert.deepEqual(second.zooms, [1]);
  assert.equal(first.screen.listenerCount("display-added"), 1);
  first.geometry.dispose(); first.geometry.dispose();
  const writes = first.writes.length;
  for (const name of ["display-added", "display-removed", "display-metrics-changed"]) {
    assert.equal(first.screen.listenerCount(name), 0); first.screen.emit(name);
  }
  first.geometry.begin({ x: 0, y: 0 }); first.geometry.move({ x: 100, y: 100 }); first.geometry.end();
  assert.equal(first.writes.length, writes);
  second.destroy(); const otherWrites = second.writes.length;
  second.screen.emit("display-removed"); assert.equal(second.writes.length, otherWrites);
  second.geometry.dispose();
});
