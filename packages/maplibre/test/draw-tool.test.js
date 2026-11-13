// @cnmw/maplibre -- unit tests for createDrawTool's pure geometry math
// (no DOM/map required: see draw-tool.js's header for why createDrawTool
// itself needs a real `map`, but these helpers do not).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDrawTool,
  rectangleRingFromCorners,
  rectanglePolygonFromCorners,
  isDegenerateRectangle,
  polygonRingFromVertices,
  isClosablePolygon,
  isSameScreenPoint,
} from '../src/draw-tool.js';

test('rectangleRingFromCorners: normalizes corners given in any order', () => {
  const ring = rectangleRingFromCorners([10, 5], [2, 1]);
  assert.deepEqual(ring, [
    [2, 1],
    [10, 1],
    [10, 5],
    [2, 5],
    [2, 1],
  ]);
});

test('rectangleRingFromCorners: closed ring (first === last)', () => {
  const ring = rectangleRingFromCorners([0, 0], [1, 1]);
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  assert.equal(ring.length, 5);
});

test('rectangleRingFromCorners: counter-clockwise winding (RFC 7946 exterior ring)', () => {
  const ring = rectangleRingFromCorners([0, 0], [1, 1]);
  // shoelace sum positive => counter-clockwise in a standard (x right, y up) frame
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    sum += x1 * y2 - x2 * y1;
  }
  assert.ok(sum > 0, `expected positive (CCW) shoelace sum, got ${sum}`);
});

test('rectanglePolygonFromCorners: a Polygon with one ring', () => {
  const poly = rectanglePolygonFromCorners([0, 0], [1, 1]);
  assert.equal(poly.type, 'Polygon');
  assert.equal(poly.coordinates.length, 1);
  assert.equal(poly.coordinates[0].length, 5);
});

test('isDegenerateRectangle: true when corners nearly coincide on either axis', () => {
  assert.equal(isDegenerateRectangle([0, 0], [0, 0]), true);
  assert.equal(isDegenerateRectangle([0, 0], [0.0000001, 5]), true); // lon collapsed
  assert.equal(isDegenerateRectangle([0, 0], [5, 0.0000001]), true); // lat collapsed
});

test('isDegenerateRectangle: false for a real rectangle', () => {
  assert.equal(isDegenerateRectangle([0, 0], [1, 1]), false);
  assert.equal(isDegenerateRectangle([9.4, 47.0], [9.6, 47.3]), false);
});

// --- polygon ------------------------------------------------------------

test('polygonRingFromVertices: closes the ring without mutating the input', () => {
  const vertices = [[0, 0], [1, 0], [1, 1]];
  const ring = polygonRingFromVertices(vertices);
  assert.deepEqual(ring, [[0, 0], [1, 0], [1, 1], [0, 0]]);
  assert.equal(vertices.length, 3, 'input untouched');
  ring[0][0] = 99;
  assert.equal(vertices[0][0], 0, 'ring holds copies, not the caller\'s arrays');
});

test('isClosablePolygon: a triangle is the smallest legal ring', () => {
  assert.equal(isClosablePolygon([]), false);
  assert.equal(isClosablePolygon([[0, 0]]), false);
  assert.equal(isClosablePolygon([[0, 0], [1, 0]]), false);
  assert.equal(isClosablePolygon([[0, 0], [1, 0], [1, 1]]), true);
});

test('isSameScreenPoint: within 8px is one click, beyond it is two', () => {
  assert.equal(isSameScreenPoint({ x: 100, y: 100 }, { x: 103, y: 104 }), true);
  assert.equal(isSameScreenPoint({ x: 100, y: 100 }, { x: 120, y: 100 }), false);
});

// A map stub small enough to drive the polygon tool's click handling, plus
// the `document` the keydown listener needs. Node has neither, so both are
// installed for the duration of each test and removed again -- the rest of
// this file is deliberately map-free (see its header), and this is the
// smallest departure that still covers the gesture logic.
function stubMap() {
  const canvas = { style: {} };
  const sources = new Map();
  const handlers = new Map();
  return {
    sources,
    getCanvas: () => canvas,
    getSource: (id) => sources.get(id),
    addSource: (id, spec) => sources.set(id, { ...spec, setData(data) { this.data = data; } }),
    addLayer: () => {},
    getLayer: () => undefined,
    removeLayer: () => {},
    removeSource: (id) => sources.delete(id),
    dragPan: { enable() {}, disable() {} },
    doubleClickZoom: { enable() {}, disable() {} },
    on: (type, fn) => {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
    },
    off: (type, fn) => handlers.get(type)?.delete(fn),
    fire: (type, event) => { for (const fn of handlers.get(type) ?? []) fn(event); },
  };
}

function withDocument(run) {
  const keyHandlers = new Set();
  const previous = globalThis.document;
  globalThis.document = {
    addEventListener: (type, fn) => { if (type === 'keydown') keyHandlers.add(fn); },
    removeEventListener: (type, fn) => { if (type === 'keydown') keyHandlers.delete(fn); },
  };
  const press = (key) => { for (const fn of [...keyHandlers]) fn({ key, preventDefault() {} }); };
  try {
    return run(press);
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
}

const clickAt = (map, x, y) => map.fire('click', { point: { x, y }, lngLat: { lng: x, lat: y } });
const dblClickAt = (map, x, y) => map.fire('dblclick', { point: { x, y }, lngLat: { lng: x, lat: y }, preventDefault() {} });

test('createDrawTool: polygon is no longer refused -- arm("polygon") arms it', () => {
  withDocument(() => {
    const tool = createDrawTool(stubMap(), { tools: ['polygon'] });
    tool.arm('polygon');
    assert.equal(tool.armed, true);
    assert.equal(tool.tool, 'polygon');
  });
});

test('createDrawTool: polygon collects clicks and closes on double-click into a draw-provenance Area', () => {
  withDocument(() => {
    const map = stubMap();
    const tool = createDrawTool(map, { tools: ['polygon'] });
    const seen = [];
    tool.on('area', (payload) => seen.push(payload.area));
    tool.arm('polygon');

    clickAt(map, 0, 0);
    clickAt(map, 10, 0);
    clickAt(map, 10, 10);
    assert.deepEqual(tool.vertices, [[0, 0], [10, 0], [10, 10]]);
    dblClickAt(map, 10, 10);

    assert.equal(seen.length, 1);
    const area = seen[0];
    assert.equal(area.provenance.source, 'draw');
    assert.equal(area.provenance.draw.tool, 'polygon');
    assert.equal(area.geometry.type, 'Polygon');
    assert.equal(area.geometry.coordinates[0].length, 4, 'closed triangle');
    assert.deepEqual(area.geometry.coordinates[0][0], area.geometry.coordinates[0][3]);
    assert.equal(tool.armed, false, 'disarms itself after the shape it was armed for');
  });
});

test('createDrawTool: the ordinary click inside a double-click does not become a duplicate corner', () => {
  withDocument(() => {
    const map = stubMap();
    const tool = createDrawTool(map, { tools: ['polygon'] });
    const seen = [];
    tool.on('area', (payload) => seen.push(payload.area));
    tool.arm('polygon');

    clickAt(map, 0, 0);
    clickAt(map, 10, 0);
    clickAt(map, 10, 10);
    clickAt(map, 10, 10); // the first half of the double-click
    dblClickAt(map, 10, 10);

    assert.equal(seen[0].geometry.coordinates[0].length, 4);
  });
});

test('createDrawTool: Enter closes a polygon, Escape cancels it', () => {
  withDocument((press) => {
    const map = stubMap();
    const tool = createDrawTool(map, { tools: ['polygon'] });
    const areas = [];
    const cancels = [];
    tool.on('area', (payload) => areas.push(payload.area));
    tool.on('cancel', (payload) => cancels.push(payload));

    tool.arm('polygon');
    clickAt(map, 0, 0);
    clickAt(map, 10, 0);
    press('Escape');
    assert.equal(areas.length, 0);
    assert.deepEqual(cancels, [{ duringDrag: false, duringDraw: true }]);
    assert.equal(tool.armed, false);

    tool.arm('polygon');
    clickAt(map, 0, 0);
    clickAt(map, 10, 0);
    clickAt(map, 10, 10);
    press('Enter');
    assert.equal(areas.length, 1);
  });
});

test('createDrawTool: too few corners will not close, and leaves the tool armed', () => {
  withDocument(() => {
    const map = stubMap();
    const tool = createDrawTool(map, { tools: ['polygon'] });
    const seen = [];
    tool.on('area', (payload) => seen.push(payload.area));
    tool.arm('polygon');

    clickAt(map, 0, 0);
    clickAt(map, 10, 0);
    dblClickAt(map, 20, 20);

    assert.equal(seen.length, 0);
    assert.equal(tool.armed, true);
  });
});

test('createDrawTool: clicking the first corner again closes the ring', () => {
  withDocument(() => {
    const map = stubMap();
    const tool = createDrawTool(map, { tools: ['polygon'] });
    const seen = [];
    tool.on('area', (payload) => seen.push(payload.area));
    tool.arm('polygon');

    clickAt(map, 0, 0);
    clickAt(map, 20, 0);
    clickAt(map, 20, 20);
    clickAt(map, 2, 2); // within 8px of the first corner

    assert.equal(seen.length, 1);
    assert.equal(seen[0].geometry.coordinates[0].length, 4);
  });
});

test('createDrawTool: `names` overrides the Area name, for hosts that translate it', () => {
  withDocument(() => {
    const map = stubMap();
    const tool = createDrawTool(map, { tools: ['polygon'], names: { drawn: 'Área dibujada' } });
    const seen = [];
    tool.on('area', (payload) => seen.push(payload.area));
    tool.arm('polygon');
    clickAt(map, 0, 0);
    clickAt(map, 10, 0);
    clickAt(map, 10, 10);
    dblClickAt(map, 10, 10);
    assert.equal(seen[0].name, 'Área dibujada');
  });
});

test('createDrawTool: a tool outside the enabled set is still refused', () => {
  const tool = createDrawTool(stubMap(), { tools: ['rectangle'] });
  assert.throws(() => tool.arm('polygon'), /not in the enabled set/);
});

test('createDrawTool: a handler that removes the tool does not silence the handlers after it', () => {
  // What portolan-browser's widget really does: its `area` handler calls
  // `setArea`, which rebuilds the map layers, which calls `remove()` --
  // and `remove()` clears the listener set this emit is walking.
  withDocument(() => {
    const map = stubMap();
    const tool = createDrawTool(map, { tools: ['polygon'] });
    const seen = [];
    tool.on('area', () => { seen.push('first'); tool.remove(); });
    tool.on('area', () => seen.push('second'));
    tool.arm('polygon');

    clickAt(map, 0, 0);
    clickAt(map, 10, 0);
    clickAt(map, 10, 10);
    dblClickAt(map, 10, 10);

    assert.deepEqual(seen, ['first', 'second']);
  });
});
