'use strict';

// All coordinates are Electron screen DIP, including displays with a negative
// origin. Apply once on user drag completion; owner movement is not a drag.
function snapFloatingBounds(bounds, { workArea, ownerBounds, threshold = 20, gap = 8 } = {}) {
  const rect = value => value && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key])) && value.width > 0 && value.height > 0;
  if (!rect(bounds)) throw new TypeError('Invalid floating window bounds');
  if (!Number.isFinite(threshold) || threshold < 0 || !Number.isFinite(gap) || gap < 0) throw new TypeError('Invalid floating window snap distance');
  const result = { ...bounds };
  const area = rect(workArea) ? workArea : null;
  const owner = rect(ownerBounds) ? ownerBounds : null;
  for (const [axis, size, cross, crossSize] of [['x', 'width', 'y', 'height'], ['y', 'height', 'x', 'width']]) {
    const candidates = [];
    for (const edge of [area, owner]) {
      if (!edge || edge[size] < bounds[size] + gap * 2) continue;
      // An unrelated owner on another row/column must not pull a free window.
      if (edge === owner && (bounds[cross] + bounds[crossSize] < edge[cross] - threshold || bounds[cross] > edge[cross] + edge[crossSize] + threshold)) continue;
      for (const value of [edge[axis] + gap, edge[axis] + edge[size] - bounds[size] - gap]) {
        const target = Math.round(value);
        if (area && (target < area[axis] || target + bounds[size] > area[axis] + area[size])) continue;
        candidates.push(target);
      }
    }
    let distance = threshold + 1;
    for (const target of candidates) {
      const next = Math.abs(target - bounds[axis]);
      if (next <= threshold && next < distance) { result[axis] = target; distance = next; }
    }
  }
  return result;
}

module.exports = { snapFloatingBounds };
