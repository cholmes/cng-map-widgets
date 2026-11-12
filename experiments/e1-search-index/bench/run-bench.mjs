#!/usr/bin/env node
// Automated driver for the E1 benchmark harness. Starts the Range-capable
// static server, drives bench.html in headless Chromium via Playwright for
// each configuration, and writes bench/results.json.
//
// Usage: node bench/run-bench.mjs

import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PORT = 8761
const BASE = `http://localhost:${PORT}`
const DUCKDB_URL = 'https://data.source.coop/tge-labs/admin-boundaries/geoBoundaries/geoBoundariesCGAZ_ADM2.parquet'

const RUNS = [
  { label: 'local-rg2048', indexUrl: `${BASE}/data/index-provisional-rg2048.parquet`, approaches: 'a,b', warmRepeats: 15 },
  { label: 'local-rg8192', indexUrl: `${BASE}/data/index-provisional-rg8192.parquet`, approaches: 'a,b', warmRepeats: 15 },
  { label: 'local-single', indexUrl: `${BASE}/data/index-provisional-single.parquet`, approaches: 'a,b', warmRepeats: 15 },
  { label: 'remote-duckdb-baseline', indexUrl: `${BASE}/data/index-provisional-rg8192.parquet`, duckdbUrl: DUCKDB_URL, approaches: 'c', duckdbRepeats: 3 },
]

function startServer() {
  return new Promise((resolve, reject) => {
    // -u: unbuffered stdout, or the "Serving..." line sits in Python's
    // pipe buffer and this never sees it in time.
    const proc = spawn('python3', ['-I', '-u', 'serve.py', String(PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let started = false
    const onData = (buf) => {
      const s = buf.toString()
      if (!started && s.includes('Serving')) {
        started = true
        resolve(proc)
      }
    }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)
    proc.on('error', reject)
    proc.on('exit', (code) => {
      if (!started) reject(new Error(`serve.py exited early with code ${code}`))
    })
    setTimeout(() => {
      if (!started) reject(new Error('serve.py did not start within 5s'))
    }, 5000)
  })
}

async function runOne(browser, cfg) {
  const page = await browser.newPage()
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error(`[browser:${cfg.label}]`, msg.text())
  })

  // duckdb-wasm's HTTP reads happen inside a dedicated Worker, which never
  // touches the page's `window.fetch` -- so the in-page byte instrumentation
  // (common.js) always reports 0 for approach (c). Playwright's CDP-level
  // page.on('response') sees Worker-issued requests too, so we use that
  // instead, purely for this approach.
  let duckdbNetBytes = 0
  let duckdbNetRequests = 0
  if (cfg.duckdbUrl) {
    page.on('response', (res) => {
      if (res.url() === cfg.duckdbUrl || res.url().endsWith(cfg.duckdbUrl.split('/').pop())) {
        duckdbNetRequests++
        const cl = res.headers()['content-length']
        if (cl) duckdbNetBytes += parseInt(cl, 10)
      }
    })
  }

  const qs = new URLSearchParams({
    indexUrl: cfg.indexUrl,
    approaches: cfg.approaches,
    label: cfg.label,
    warmRepeats: String(cfg.warmRepeats || 15),
  })
  if (cfg.duckdbUrl) qs.set('duckdbUrl', cfg.duckdbUrl)
  if (cfg.duckdbRepeats) qs.set('duckdbRepeats', String(cfg.duckdbRepeats))

  const url = `${BASE}/bench/bench.html?${qs.toString()}`
  console.log(`\n=== ${cfg.label} ===\n${url}`)
  await page.goto(url, { timeout: 60000 })
  await page.waitForFunction('window.__DONE__ === true', { timeout: 180000 })
  const results = await page.evaluate(() => window.__RESULTS__)
  if (cfg.duckdbUrl) {
    results.duckdbWasmNetwork = {
      totalBytes: duckdbNetBytes,
      totalRequests: duckdbNetRequests,
      note: 'Captured via Playwright CDP page.on("response"), since duckdb-wasm fetches from a Worker context that bypasses window.fetch instrumentation. Aggregated across all scripted queries x duckdbRepeats in this run, not attributable to a single query.',
    }
  }
  await page.close()
  return results
}

async function main() {
  console.log('Starting serve.py...')
  const server = await startServer()
  console.log(`Server up at ${BASE}`)

  const browser = await chromium.launch()
  const allResults = []
  try {
    for (const cfg of RUNS) {
      const r = await runOne(browser, cfg)
      allResults.push(r)
      console.log(JSON.stringify(r, null, 2).slice(0, 2000))
    }
  } finally {
    await browser.close()
    server.kill()
  }

  const outPath = path.join(__dirname, 'results.json')
  writeFileSync(outPath, JSON.stringify(allResults, null, 2))
  console.log(`\nWrote ${outPath}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
