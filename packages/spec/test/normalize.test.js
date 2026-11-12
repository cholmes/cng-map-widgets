import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName } from '../src/normalize.js';

test('normalizeName lowercases and trims', () => {
  assert.equal(normalizeName('  Contra Costa  '), 'contra costa');
});

test('normalizeName strips accents (NFD + combining-mark strip)', () => {
  assert.equal(normalizeName('Bálsamo'), 'balsamo'); // "Bálsamo"
  assert.equal(normalizeName('São Paulo'), 'sao paulo'); // "São Paulo"
});

test('normalizeName keeps hyphen and apostrophe', () => {
  assert.equal(normalizeName("Coeur d'Alene"), "coeur d'alene");
  assert.equal(normalizeName('Winston-Salem'), 'winston-salem');
});

test('normalizeName drops punctuation other than - and \'', () => {
  assert.equal(normalizeName('St. Louis, MO!'), 'st louis mo');
});

test('normalizeName collapses internal whitespace', () => {
  assert.equal(normalizeName('New   York'), 'new york');
});

test('normalizeName keeps non-Latin scripts', () => {
  assert.equal(normalizeName('東京'), '東京');
});
