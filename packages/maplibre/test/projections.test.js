import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utmDefinition, registerKnownProjections, KNOWN_UTM_CODES } from '../src/projections.js';
import { DECK_BUNDLE_URL } from '../src/deck-loader.js';

// deck.gl-raster resolves a COG's EPSG code through a registry that knows what
// proj4 ships -- WGS84 UTM -- and asks epsg.io for everything else. E12 saw
// that request on the first NAIP scene (EPSG:26910). A UTM zone is fully
// described by its number, hemisphere and datum, so the families imagery is
// actually published in are defined here instead.

const WGS84 = (zone, south = false) => `+proj=utm +zone=${zone}${south ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`;
const NAD83 = (zone) => `+proj=utm +zone=${zone} +datum=NAD83 +units=m +no_defs`;
const GRS80 = (zone, south = false) => `+proj=utm +zone=${zone}${south ? ' +south' : ''} +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;

test('utmDefinition: one known code per family gives the right zone, hemisphere and datum', () => {
  assert.equal(utmDefinition(32618), WGS84(18)); // WGS 84 / UTM zone 18N
  assert.equal(utmDefinition(32721), WGS84(21, true)); // WGS 84 / UTM zone 21S
  assert.equal(utmDefinition(26910), NAD83(10)); // NAD83 / UTM zone 10N -- NAIP
  assert.equal(utmDefinition(6339), GRS80(10)); // NAD83(2011) / UTM zone 10N
  assert.equal(utmDefinition(25832), GRS80(32)); // ETRS89 / UTM zone 32N
  assert.equal(utmDefinition(31981), GRS80(21, true)); // SIRGAS 2000 / UTM zone 21S -- OpenAerialMap
  assert.equal(utmDefinition(28355), GRS80(55, true)); // GDA94 / MGA zone 55
  assert.equal(utmDefinition(7855), GRS80(55, true)); // GDA2020 / MGA zone 55
});

test('utmDefinition: the first and last code of each family, including the two that do not count in order', () => {
  assert.equal(utmDefinition(32601), WGS84(1));
  assert.equal(utmDefinition(32660), WGS84(60));
  assert.equal(utmDefinition(32701), WGS84(1, true));
  assert.equal(utmDefinition(32760), WGS84(60, true));
  assert.equal(utmDefinition(26901), NAD83(1));
  assert.equal(utmDefinition(26923), NAD83(23));
  // NAD83(2011) starts at zones 59N and 60N, THEN counts from 1N.
  assert.equal(utmDefinition(6328), GRS80(59));
  assert.equal(utmDefinition(6329), GRS80(60));
  assert.equal(utmDefinition(6330), GRS80(1));
  assert.equal(utmDefinition(6348), GRS80(19));
  assert.equal(utmDefinition(25828), GRS80(28));
  assert.equal(utmDefinition(25838), GRS80(38));
  // SIRGAS 2000: zones 11N-22N, then 17S-25S.
  assert.equal(utmDefinition(31965), GRS80(11));
  assert.equal(utmDefinition(31976), GRS80(22));
  assert.equal(utmDefinition(31977), GRS80(17, true));
  assert.equal(utmDefinition(31985), GRS80(25, true));
  assert.equal(utmDefinition(28348), GRS80(48, true));
  assert.equal(utmDefinition(28358), GRS80(58, true));
  assert.equal(utmDefinition(7846), GRS80(46, true));
  assert.equal(utmDefinition(7859), GRS80(59, true));
});

test('utmDefinition: codes just outside each range, and non-UTM codes, give null', () => {
  const outside = [32600, 32661, 32700, 32761, 26900, 26924, 6327, 6349, 25827, 25839, 31964, 31986, 28347, 28359, 7845, 7860];
  for (const code of [...outside, 4326, 3857, 0, -32618, 32618.5, NaN, '26910', null, undefined]) {
    assert.equal(utmDefinition(code), null, String(code));
  }
});

test('KNOWN_UTM_CODES lists exactly the codes utmDefinition answers for', () => {
  assert.equal(KNOWN_UTM_CODES.length, 60 + 60 + 23 + 21 + 11 + 21 + 11 + 14);
  assert.equal(new Set(KNOWN_UTM_CODES).size, KNOWN_UTM_CODES.length);
  assert.ok(KNOWN_UTM_CODES.every((code) => typeof utmDefinition(code) === 'string'));
});

/** proj4's `defs(name)` / `defs(name, definition)`, with WGS84 UTM north already known, as in the real one. */
function fakeProj4() {
  const known = new Map(KNOWN_UTM_CODES.filter((c) => c > 32600 && c <= 32660).map((c) => [`EPSG:${c}`, 'builtin']));
  const added = [];
  const proj4 = { defs: (name, def) => (def === undefined ? known.get(name) : (known.set(name, def), added.push(name), undefined)) };
  return { proj4, known, added };
}

test('registerKnownProjections registers each code proj4 lacks once, and is idempotent', () => {
  const { proj4, known, added } = fakeProj4();
  assert.equal(registerKnownProjections({ proj4 }), KNOWN_UTM_CODES.length - 60);
  assert.equal(known.get('EPSG:26910'), NAD83(10));
  assert.equal(known.get('EPSG:31981'), GRS80(21, true));
  assert.equal(known.get('EPSG:32618'), 'builtin', 'a definition proj4 already has is left alone');
  assert.equal(new Set(added).size, added.length);
  assert.equal(registerKnownProjections({ proj4 }), 0);
});

test('registerKnownProjections does nothing, quietly, for a module set with no proj4', () => {
  assert.equal(registerKnownProjections({}), 0);
  assert.equal(registerKnownProjections(null), 0);
});

// The real committed bundle: its registry must answer for these codes WITHOUT
// asking epsg.io, which is the point of the whole file.
test('in the committed bundle, registered UTM codes resolve with no request', async () => {
  const deck = await import(DECK_BUNDLE_URL);
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    throw new Error('no network in this test');
  };
  try {
    assert.ok(registerKnownProjections(deck) > 0);
    const naip = await deck.epsgResolver(26910);
    assert.equal(naip.projName, 'utm');
    assert.equal(naip.zone, 10);
    const oam = await deck.epsgResolver(31981);
    assert.equal(oam.zone, 21);
    assert.equal(oam.utmSouth, true);
    await deck.epsgResolver(7855);
    assert.deepEqual(asked, []);
    // ...and the definition is right: zone 10's central meridian is 123 W.
    const [x, y] = deck.proj4('EPSG:4326', 'EPSG:26910', [-123, 45]);
    assert.ok(Math.abs(x - 500000) < 0.01, `easting ${x}`);
    assert.ok(Math.abs(y - 4982950) < 5, `northing ${y}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});
