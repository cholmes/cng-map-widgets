# @cngeo/timeline

A histogram timeline over **time-chunked map data**: the arithmetic of days
and months, the rules for a set of chunks, an orchestrator that runs them, a
playback clock, and a canvas component. No map library.

Plain ESM + JSDoc. No build step. It imports only `@cngeo/spec`.

Extracted and generalised from
[firms-catalog](https://github.com/portolan-mirrors/firms-catalog)'s FIRMS
explorer, whose chunks were calendar years. Here a chunk is any span: a year
of days, a month of days, a rolling week, a whole record by month.

For the MapLibre side — PMTiles chunks drawn with deck.gl, and a
`TimelineControl` — see [`@cngeo/maplibre`](../maplibre/README.md).

## The idea in five lines

1. Data over time is published as **chunks**: files that each cover a span.
2. A **chunk descriptor** says where one is and what it covers.
3. The **axis** is the union of the chunks. What is not loaded is a **gap**,
   shown as not loaded — never as zero.
4. What is **loaded follows the view**; what **draws follows the selection**.
5. Where chunks overlap, each bucket has one **owner**.

## Chunks

```js
import { chunksFromTemplate, validateChunks } from '@cngeo/timeline';

// A chunk a year, for a record that began in November 2000 and runs to today.
const years = chunksFromTemplate({
  template: 'https://example.org/fires/year={YYYY}/fire-{YYYY}.pmtiles',
  period: 'year',            // 'year' | 'month' | 'week' | 'day' | { days: n }
  start: '2000-11-01',
});

// Or written out. `start` and `end` are days, inclusive. `unit` is the size
// of the buckets INSIDE the chunk -- nothing to do with how long it is.
const chunks = validateChunks([
  ...years,
  { id: 'latest', start: '20261118', end: '20261125', url: 'https://example.org/fires/latest.pmtiles', priority: 1 },
  { id: 'alltime', start: '20001101', end: '20261125', unit: 'month', url: 'https://example.org/fires/alltime.pmtiles' },
]);
```

A descriptor is `{ id, start, end, unit: 'day'|'month', format, url, priority? }`.
`priority` decides who owns a bucket two chunks share: a rolling week rebuilt
hourly should outrank the year that holds a staler copy of the same days. A
tie goes to the narrower chunk.

`chunksFromStac()` in [`@cngeo/stac`](../stac/README.md) builds the same list
from a STAC collection's items.

## The rules, as functions

All pure; none opens a file.

| | |
|---|---|
| `axisFor(chunks, unit)` | The union of the chunks of one unit: `{ unit, min, max }`. |
| `gapsIn(loaded, axis)` | What no loaded chunk covers, as bucket-index ranges. |
| `ownerOf(chunks, key)` | Which chunk a bucket's numbers come from. |
| `ownedRanges(chunks, chunk, from, to)` | The buckets of a range a chunk owns, as runs. |
| `forView(chunks, { from, to }, { cap })` | Which chunks a view needs loaded, and at which unit. |
| `forSelection(chunks, { from, to }, unit)` | Every chunk that owns part of a selection. |

`forView` picks the finest unit whose chunks can show the window within `cap`
(default 3) — and that shows at least as much of it as a coarser unit would.
A six-year view is not a wider daily view; it is what a monthly overview
chunk is for. With no coarser chunk, the `cap` chunks nearest the middle load
and the rest reads as not loaded. A chunk wholly inside another's span (the
rolling week) is an overlay and does not count against the cap.

## The orchestrator

```js
import { createChunkSet } from '@cngeo/timeline';

const set = createChunkSet({ chunks, formats: { pmtiles: myFormat }, cap: 3 });
set.on('change', (state) => { /* axis, gaps, loaded, drawing, histogram, … */ });
set.setView({ from: '20260817', to: '20261125' });        // day keys
set.setSelection({ from: '20261120', to: '20261125' });
set.setViewport(mapBounds);                                // handed to each mount's histogram()
```

`state`: `{ unit, axis, gaps, loaded, drawing, outgoing, pending, failed,
histogram, partial, view, selection }`.

- **Loaded follows the view.** Chunks are added as the view reaches them —
  at most every 150 ms while a gesture is in flight (`setView(w, { dragging:
  true })`), never more than twice the cap held — and let go only after
  450 ms of stillness. A chunk the selection draws from is never let go.
- **Drawing follows the selection**: every loaded chunk that owns part of
  it, each told only its own buckets.
- **Handover.** A chunk that stops drawing while its successor has nothing on
  screen is frozen — it keeps showing what it showed — until the successor
  has settled, or eight seconds.
- **The unit** (days or months) changes only when things are still.
- **A chunk that fails** or never answers (60 s) is in `failed`, with a
  retryable `LAYER_LOAD_FAILED`; its span stays a gap; the rest keep working;
  `set.retry(id)` tries again.
- **The histogram** takes each bucket from its owner, 180 ms after new data.
  `partial` is true while anything is still loading.

### A chunk format

The orchestrator knows nothing about files or maps. A format does:

```js
const myFormat = {
  async open(chunk, { signal }) { /* read what the chunk says about itself */ return info; },
  mount({ chunk, info, changed, settled }) {
    // call changed() when data arrives, settled(true) when what is on screen has loaded
    return {
      setWindow(window) {},        // { unit, ranges: [[fromKey, toKey], …] } to draw, or null
      histogram(viewport) {},      // → { [bucketKey]: count }
      freeze() {},                 // keep showing what is shown, until the next setWindow()
      destroy() {},
    };
  },
};
```

`@cngeo/maplibre` ships one, for PMTiles. Another — GeoParquet, say — is the
same four methods; `test/helpers/fake-format.js` is the smallest example.

## Playback

```js
import { createPlayback } from '@cngeo/timeline';

const playback = createPlayback({
  step: (direction) => (direction === 'restart' ? (timeline.toStart(), true) : timeline.shift(direction)),
  ready: () => !set.state.partial,     // hold while the next chunk loads
  speed: 4,                            // steps a second
  reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
});
playback.play();
```

`step` returns `false` at the end; playback then stops, or with `loop` asks
for `'restart'`. With `reducedMotion` it never runs faster than once a second.

## The canvas

```js
import { TimelineCanvas } from '@cngeo/timeline';

const timeline = new TimelineCanvas(canvas, {
  onChange: ({ view, selection, dragging }) => {   // day keys, whatever the unit
    set.setView(view, { dragging });
    set.setSelection(selection);
  },
});
timeline.setAxis(set.state.axis);            // { unit, min, max }
timeline.setValues(set.state.histogram);
timeline.setGaps(set.state.gaps);
```

Drag the selection or its handles; drag elsewhere to pan; wheel or pinch to
zoom; shift-drag to draw a new selection; arrow keys move it (shift widens
it); `f` fits the view to it. `setAxis(axis, { keep: true })` changes the unit
under the same dates. `shift(n)`, `toStart()`, `setViewDays()`,
`setSelectionDays()`, `setSpan()`, `zoomBy()`, `fitToSelection()`,
`setTheme()` (`TIMELINE_THEME_DARK`, `TIMELINE_THEME_LIGHT`).

## Keys

A bucket key is a calendar day or month as digits — `20261125`, `202611`.
`Date` is avoided for the arithmetic: a key names a day, not an instant, and
a local-time `Date` shifts a whole axis by a bucket west of Greenwich.
`dayKeyOfDate()` reads a date as its **UTC** day.

## Errors

`TIMELINE_INVALID` (not retryable): a chunk list, a descriptor or a bucket
key that cannot be used. A chunk that is fine and will not load is
`LAYER_LOAD_FAILED` (retryable), in `state.failed`.

## License

MIT
