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

/** release.yml with its YAML comments removed: a list in a comment is not the list that runs. */
function workflowCode() {
  return readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/** The `order="…"` list in release.yml: package directories, in publish order. */
function publishOrder() {
  const code = workflowCode();
  const lists = [...code.matchAll(/order="([^"]+)"/g)];
  assert.equal(lists.length, 1, 'release.yml assigns order="…" exactly once, outside a comment');
  assert.match(code, /for pkg in \$order; do/, 'and the publish loop is over that list');
  return lists[0][1].split(/\s+/).filter(Boolean);
}

const EDGES = ['dependencies', 'peerDependencies', 'optionalDependencies'];
const PINNED = [...EDGES, 'devDependencies'];

test('every package is published, once', () => {
  const order = publishOrder();
  assert.deepEqual([...order].sort(), [...dirs].sort(), 'release.yml lists exactly the packages that exist');
  assert.equal(new Set(order).size, order.length, 'none twice');
});

test('a package is published after every @cngeo package it depends on', () => {
  const order = publishOrder();
  for (const [dir, manifest] of manifests) {
    for (const name of EDGES.flatMap((kind) => Object.keys(manifest[kind] ?? {}))) {
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
    // Every pin on a sibling, in whichever section: exact, and this version.
    for (const kind of PINNED) {
      for (const [name, pin] of Object.entries(manifest[kind] ?? {})) {
        if (name.startsWith('@cngeo/')) assert.equal(pin, version, `${manifest.name} ${kind}: ${name} is pinned at ${pin}`);
      }
    }
    // Every package states its own version in source (design doc 4.4, rule
    // 5), once, and it is this one. Found wherever under src/ it is declared.
    const stated = [];
    for (const file of readdirSync(path.join(packagesDir, dir, 'src')).filter((f) => f.endsWith('.js'))) {
      const text = readFileSync(path.join(packagesDir, dir, 'src', file), 'utf8');
      for (const m of text.matchAll(/^export const VERSION = (['"])([^'"]+)\1;/gm)) stated.push({ file, version: m[2] });
    }
    assert.equal(stated.length, 1, `${dir} declares VERSION exactly once under src/ (found ${stated.length})`);
    assert.equal(stated[0].version, version, `${dir}/src/${stated[0].file} says VERSION ${stated[0].version}`);
  }
});
