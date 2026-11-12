// `DEFAULT_INDEX_URL` and the `indexUrl` option's resolution rules
// (design call #10: "Default index URL: the published
// portolan-mirrors/geoboundaries source.coop URLs; `indexUrl`
// overridable").
//
// The default used to be `'./data/index.json'` -- a relative *development*
// path that resolved to a 404 for anybody outside this repo's own demo
// directory (and, because `.gitignore` excludes `data/`, inside it too on
// a fresh clone). Any non-string `indexUrl`, an array included, fell
// through to it silently, so asking for two specific gazetteers got you a
// third one you never named with no error at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Geocoder, DEFAULT_INDEX_URL } from '../src/index.js';
import { isCnmwError } from '@cnmw/spec';

/** Read back the manifest URL a constructed Geocoder will actually load. */
function manifestUrlOf(options) {
  return new Geocoder(options)._manifestUrl;
}

test('DEFAULT_INDEX_URL is an absolute https URL to a published manifest, not a relative dev path', () => {
  const url = new URL(DEFAULT_INDEX_URL); // throws if relative
  assert.equal(url.protocol, 'https:');
  assert.equal(url.host, 'data.source.coop');
  assert.ok(DEFAULT_INDEX_URL.endsWith('/index.json'), 'points at the manifest, not the parquet');
  // geoBoundaries (CC-BY-4.0), deliberately, not the ODbL Overture index:
  // a default nobody chose must not impose share-alike terms.
  assert.match(DEFAULT_INDEX_URL, /geoboundaries/);
});

test('no indexUrl uses DEFAULT_INDEX_URL', () => {
  assert.equal(manifestUrlOf({}), DEFAULT_INDEX_URL);
  assert.equal(manifestUrlOf({ indexUrl: undefined }), DEFAULT_INDEX_URL);
  assert.equal(manifestUrlOf({ indexUrl: null }), DEFAULT_INDEX_URL);
});

test('an explicit indexUrl always wins, relative or absolute', () => {
  assert.equal(manifestUrlOf({ indexUrl: 'https://example.test/names/index.json' }), 'https://example.test/names/index.json');
  assert.equal(manifestUrlOf({ indexUrl: './data/index.json' }), './data/index.json');
});

test('a single-element indexUrl array is accepted: there is nothing ambiguous about it', () => {
  assert.equal(manifestUrlOf({ indexUrl: ['https://example.test/one/index.json'] }), 'https://example.test/one/index.json');
});

test('a multi-source indexUrl array refuses by name instead of silently loading the default', () => {
  assert.throws(
    () => manifestUrlOf({ indexUrl: ['https://a.test/index.json', 'https://b.test/index.json'] }),
    (err) => {
      assert.ok(isCnmwError(err));
      assert.equal(err.code, 'INDEX_MULTI_SOURCE_UNSUPPORTED');
      assert.match(err.message, /not implemented/);
      assert.deepEqual(err.context.indexUrl, ['https://a.test/index.json', 'https://b.test/index.json']);
      return true;
    },
  );
});

test('a nonsense indexUrl refuses rather than falling back', () => {
  for (const bad of [42, {}, true]) {
    assert.throws(() => manifestUrlOf({ indexUrl: bad }), { code: 'INDEX_MULTI_SOURCE_UNSUPPORTED' });
  }
});
