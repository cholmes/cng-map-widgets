// The release, as the repository states it: which packages go up, in what
// order, at what version. Nothing here touches the network or npm.
//
// It lives in @cngeo/spec's tests because every package depends on spec and
// none of them owns the workflow.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const packagesDir = path.join(root, 'packages');
const dirs = readdirSync(packagesDir).filter((d) => existsSync(path.join(packagesDir, d, 'package.json')));
const manifests = new Map(dirs.map((d) => [d, JSON.parse(readFileSync(path.join(packagesDir, d, 'package.json'), 'utf8'))]));
const dirOf = new Map([...manifests].map(([dir, m]) => [m.name, dir]));

/** The `order="…"` list in release.yml: package directories, in publish order. */
function publishOrder() {
  const workflow = readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
  const match = /order="([^"]+)"/.exec(workflow);
  assert.ok(match, 'release.yml has an order="…" list');
  return match[1].split(/\s+/).filter(Boolean);
}

test('every package is published, once', () => {
  const order = publishOrder();
  assert.deepEqual([...order].sort(), [...dirs].sort(), 'release.yml lists exactly the packages that exist');
  assert.equal(new Set(order).size, order.length, 'none twice');
});

test('a package is published after every @cngeo package it depends on', () => {
  const order = publishOrder();
  for (const [dir, manifest] of manifests) {
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
      if (!name.startsWith('@cngeo/')) continue;
      const needs = dirOf.get(name);
      assert.ok(needs, `${manifest.name} depends on ${name}, which is not a package here`);
      assert.ok(order.indexOf(needs) < order.indexOf(dir), `${needs} must be published before ${dir}: npm cannot resolve ${name} otherwise`);
    }
  }
});

test('release.yml counts the packages it publishes correctly', () => {
  const workflow = readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
  const said = /add the (\d+) entries/.exec(workflow);
  assert.ok(said, 'the note about trusted-publisher entries names a number');
  assert.equal(Number(said[1]), dirs.length);
});

test('one version across the packages, their pins on each other, and their VERSION constants', () => {
  const versions = new Set([...manifests.values()].map((m) => m.version));
  assert.equal(versions.size, 1, `one version, found ${[...versions].join(', ')}`);
  const [version] = versions;
  for (const [dir, manifest] of manifests) {
    for (const [name, pin] of Object.entries({ ...manifest.dependencies })) {
      if (name.startsWith('@cngeo/')) assert.equal(pin, version, `${manifest.name} pins ${name} at ${pin}`);
    }
    // Wherever a package states its own version in source.
    for (const file of ['src/index.js', 'src/geocoder.js']) {
      const full = path.join(packagesDir, dir, file);
      if (!existsSync(full)) continue;
      const said = /export const VERSION = '([^']+)'/.exec(readFileSync(full, 'utf8'));
      if (said) assert.equal(said[1], version, `${dir}/${file} says VERSION ${said[1]}`);
    }
  }
});
