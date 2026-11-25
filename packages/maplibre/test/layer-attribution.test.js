import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attributionHtml } from '../src/layer-attribution.js';

// Attribution text comes from remote collection documents and ends up in
// MapLibre's attribution control, which sets it as HTML. This is the one
// place layer text becomes markup, so it is the one place that must escape.

test('text, licence and a link, escaped', () => {
  const html = attributionHtml([{ text: 'UNOSAT', license: 'CC-BY-4.0', url: 'https://unosat.org' }]);
  // The href is the URL as parsed (normalised), not the string as given.
  assert.equal(html, '<a href="https://unosat.org/" target="_blank" rel="noopener noreferrer">UNOSAT</a> (CC-BY-4.0)');
});

test('markup in text or licence is escaped, never interpreted', () => {
  const html = attributionHtml([{ text: '<img src=x onerror=alert(1)>', license: '"><script>alert(2)</script>' }]);
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&quot;&gt;&lt;script&gt;/);
});

test('a url that is not http(s) is never made a link', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'ftp://x/y', ' javascript:alert(1)', 'not a url']) {
    const html = attributionHtml([{ text: 'X', license: 'CC0-1.0', url }]);
    assert.doesNotMatch(html, /href/, url);
    assert.equal(html, 'X (CC0-1.0)');
  }
});

test('a quote in a url cannot break out of the href', () => {
  const html = attributionHtml([{ text: 'X', url: 'https://example.org/"onmouseover="alert(1)' }]);
  assert.doesNotMatch(html, /"onmouseover="/);
});

test('share-alike is stated, from either key style', () => {
  assert.match(attributionHtml([{ text: 'S2', license: 'CC-BY-SA-3.0-IGO', shareAlike: true }]), /share-alike/);
  assert.match(attributionHtml([{ text: 'OSM', license: 'ODbL-1.0', share_alike: true }]), /share-alike/);
  assert.doesNotMatch(attributionHtml([{ text: 'X', license: 'CC-BY-4.0', shareAlike: false, share_alike: false }]), /share-alike/);
});

test('several credits are joined; duplicates are stated once; none gives an empty string', () => {
  const a = { text: 'A', license: 'CC0-1.0' };
  assert.equal(attributionHtml([a, { text: 'B' }, a]), 'A (CC0-1.0) | B');
  assert.equal(attributionHtml([]), '');
  assert.equal(attributionHtml(undefined), '');
  assert.equal(attributionHtml([{}, null]), '');
});
