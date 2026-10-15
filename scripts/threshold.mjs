#!/usr/bin/env node
// Binary-searches the smallest request-target whose redirect no longer fits in
// nginx's default 4k buffer, using the A2 guard (the highest factor that needs
// no special idiom). The quotes are split over three query parameters.
//
//   node scripts/threshold.mjs                       # nginx/compose-2replicas
//   node scripts/threshold.mjs nginx/explicit-2peers

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rawGet, sleep, writeEvidence } from './lib.mjs';

const name = process.argv[2] ?? 'nginx/compose-2replicas';
const dir = join('lab/topologies', name);
const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
const compose = ['compose', '-p', `thr-${name.replace('/', '-')}`, '-f', join(dir, 'compose.yml')];

const GRANULARITY = 8;

function target(bytes) {
  const base = '/admin?a=&b=&c=';
  const per = Math.max(1, Math.floor((bytes - base.length) / 3));
  const q = '"'.repeat(per);
  return `/admin?a=${q}&b=${q}&c=${q}`;
}

// After a 502 the peer that answered is out for fail_timeout. Wait until the
// pool serves again so every probe starts from the same state.
async function waitForPool() {
  for (let i = 0; i < 120; i++) {
    if ((await rawGet(meta.port, '/home')).status === 200) return;
    await sleep(1000);
  }
  throw new Error('pool did not recover in 120s');
}

async function probe(bytes) {
  await waitForPool();
  const r = await rawGet(meta.port, target(bytes));
  console.log(`  ${String(r.requestBytes).padStart(5)} B  ${r.status}  Location ${r.locationBytes} B`);
  return r;
}

function down() {
  try {
    execFileSync('docker', [...compose, 'down', '-v', '--remove-orphans'], { stdio: 'pipe' });
  } catch {}
}

async function main() {
  down();
  execFileSync('docker', [...compose, 'up', '-d', '--remove-orphans'], { stdio: 'pipe' });
  await waitForPool();
  console.log(`${name}: A2 guard, quotes over three query parameters\n`);

  let lo = 256;
  let hi = 4096;
  const low = await probe(lo);
  const high = await probe(hi);
  if (low.status !== 302 || high.status !== 502) {
    throw new Error(`expected 302 at ${lo} B and 502 at ${hi} B, got ${low.status} and ${high.status}`);
  }

  let lastOk = low;
  let firstBad = high;
  while (hi - lo > GRANULARITY) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await probe(mid);
    if (r.status === 502) {
      hi = mid;
      firstBad = r;
    } else if (r.status === 302) {
      lo = mid;
      lastOk = r;
    } else {
      throw new Error(`unexpected status ${r.status} at ${mid} B`);
    }
  }

  const summary = {
    topology: name,
    largestRelayedRequestBytes: lastOk.requestBytes,
    largestRelayedLocationBytes: lastOk.locationBytes,
    smallestRejectedRequestBytes: firstBad.requestBytes,
  };
  console.log(`\n  largest request relayed   ${summary.largestRelayedRequestBytes} B (Location ${summary.largestRelayedLocationBytes} B)`);
  console.log(`  smallest request rejected ${summary.smallestRejectedRequestBytes} B`);
  console.log(`  json: ${writeEvidence(`threshold-${name.replace('/', '-')}`, summary)}`);
}

try {
  await main();
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  process.exitCode = 1;
} finally {
  down();
}
