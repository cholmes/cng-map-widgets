import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachDropTarget } from '../src/upload.js';

// Node's global `EventTarget` + `Event` are enough to exercise
// attachDropTarget's wiring without a DOM: it only calls
// addEventListener/removeEventListener and reads `e.dataTransfer`/
// `e.clipboardData`/`e.preventDefault()` off whatever event object the
// host dispatches, so a plain EventTarget plus a custom event subclass
// stands in fine.

class DropEvent extends Event {
  constructor(type, dataTransfer) {
    super(type, { cancelable: true });
    this.dataTransfer = dataTransfer;
  }
}
class PasteEvent extends Event {
  constructor(type, clipboardData) {
    super(type, { cancelable: true });
    this.clipboardData = clipboardData;
  }
}

test('attachDropTarget: a dropped GeoJSON file produces an UploadResult via onResult', async () => {
  const el = new EventTarget();
  const results = [];
  const errors = [];
  const unsubscribe = attachDropTarget(el, (r) => results.push(r), { onError: (e) => errors.push(e) });

  const fc = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } };
  const file = new File([JSON.stringify(fc)], 'dropped.geojson', { type: 'application/geo+json' });
  const dataTransfer = { files: [file] };
  el.dispatchEvent(new DropEvent('drop', dataTransfer));

  // areaFromFile is async; give its microtasks a turn.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(errors.length, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0].area.provenance.source, 'upload');
  unsubscribe();
});

test('attachDropTarget: dropping an unsupported file reports via onError, not a thrown/unhandled rejection', async () => {
  const el = new EventTarget();
  const results = [];
  const errors = [];
  attachDropTarget(el, (r) => results.push(r), { onError: (e) => errors.push(e) });

  const file = new File(['nope'], 'data.shp', { type: 'application/octet-stream' });
  el.dispatchEvent(new DropEvent('drop', { files: [file] }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(results.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'UPLOAD_UNSUPPORTED_FORMAT');
});

test('attachDropTarget: pasted GeoJSON text (no file) is parsed via areaFromGeoJson', async () => {
  const el = new EventTarget();
  const results = [];
  attachDropTarget(el, (r) => results.push(r));

  const fc = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } };
  const clipboardData = { files: [], getData: (mime) => (mime === 'text/plain' ? JSON.stringify(fc) : '') };
  el.dispatchEvent(new PasteEvent('paste', clipboardData));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(results.length, 1);
  assert.equal(results[0].area.name, 'Pasted GeoJSON');
});

test('attachDropTarget: unsubscribe stops further dispatch from being handled', async () => {
  const el = new EventTarget();
  const results = [];
  const unsubscribe = attachDropTarget(el, (r) => results.push(r));
  unsubscribe();

  const fc = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } };
  const file = new File([JSON.stringify(fc)], 'x.geojson', { type: 'application/geo+json' });
  el.dispatchEvent(new DropEvent('drop', { files: [file] }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(results.length, 0);
});
