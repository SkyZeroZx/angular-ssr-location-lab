#!/usr/bin/env node
// Raises the payload step by step against one topology and reports where the
// proxy stops relaying the redirect. The topology runner always sends the
// same ~1.4 KB request, which says nothing about a proxy with a bigger buffer.
//
// Three numbers come out of it:
//   accepted  the largest request the proxy forwards at all (4xx above it)
//   relayed   the largest Location it still passes to the client
//   rejected  the smallest request that gets a 502/503 instead
//
//   node scripts/escalate.mjs nginx/big-buffer --producer a2
//   node scripts/escalate.mjs haproxy/defaults

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rawGet, sleep, writeEvidence } from './lib.mjs';

const argv = process.argv.slice(2);
const option = (key, fallback) => {
  const i = argv.indexOf(`--${key}`);
  return i === -1 ? fallback : argv[i + 1];
};

const PRODUCERS = {
  a1: { path: '/home/(x)?q={payload}', note: 'router normalization, ~3x' },
  a2: { path: '/admin?q={payload}', note: 'returnUrl guard, ~5x' },
};

const producer = option('producer', 'a1');
const max = Number(option('max', 20000));
const name = argv.find((arg, i) => !arg.startsWith('--') && !['--producer', '--max'].includes(argv[i - 1]));

if (!name || !PRODUCERS[producer]) {
  console.error('usage: node scripts/escalate.mjs <proxy>/<name> [--producer a1|a2] [--max 20000]');
  process.exit(1);
}

const dir = join('lab/topologies', name);
const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
const compose = ['compose', '-p', `esc-${name.replace('/', '-')}`, '-f', join(dir, 'compose.yml')];
const host = meta.hostHeader ?? 'localhost';

const STEPS = [
  1400, 2000, 3000, 4000, 5000, 6000, 7000, 7900, 8100, 9000, 10000, 11000, 12000, 13000, 14000,
  15000, 15500, 16000, 16500, 17000, 18000, 20000,
].filter((n) => n <= max);

function target(bytes) {
  const template = PRODUCERS[producer].path;
  const overhead = template.replace('{payload}', '').length;
  return template.replace('{payload}', '"'.repeat(Math.max(1, bytes - overhead)));
}

function down() {
  try {
    execFileSync('docker', [...compose, 'down', '-v', '--remove-orphans'], { stdio: 'pipe' });
  } catch {}
}

async function main() {
  down();
  execFileSync('docker', [...compose, 'up', '-d', '--remove-orphans'], { stdio: 'pipe' });
  let ready = false;
  for (let i = 0; i < 90 && !ready; i++) {
    ready = (await rawGet(meta.port, meta.legitPath ?? '/home', { host })).status === 200;
    if (!ready) await sleep(1500);
  }
  if (!ready) throw new Error('proxy never answered 200');

  console.log(`${name} (${meta.proxy}), producer ${producer.toUpperCase()}: ${PRODUCERS[producer].note}\n`);
  console.log('   request  code    Location   factor  result');

  const rows = [];
  let accepted = null;
  let relayed = null;
  let rejected = null;

  for (const bytes of STEPS) {
    const r = await rawGet(meta.port, target(bytes), { host, timeout: 20000 });
    let result;
    if (r.status >= 300 && r.status < 400) {
      result = 'relayed';
      accepted = r.requestBytes;
      relayed = Math.max(relayed ?? 0, r.locationBytes);
    } else if ([500, 502, 503].includes(r.status)) {
      result = 'rejected by the proxy';
      accepted = r.requestBytes;
      rejected ??= r.requestBytes;
    } else if ([400, 414, 431].includes(r.status)) {
      result = 'request refused';
    } else {
      result = `status ${r.status}${r.error ? `, ${r.error}` : ''}`;
    }

    const factor = r.locationBytes ? `${(r.locationBytes / r.requestBytes).toFixed(2)}x` : '-';
    console.log(
      `  ${String(r.requestBytes).padStart(7)} B  ${String(r.status ?? 'ERR').padEnd(4)}` +
        `  ${String(r.locationBytes).padStart(8)} B  ${factor.padStart(7)}  ${result}`,
    );
    rows.push({ requestBytes: r.requestBytes, status: r.status, locationBytes: r.locationBytes, result });

    // A refused request means larger ones will be refused too.
    if ([400, 414, 431].includes(r.status)) break;
  }

  const summary = { topology: name, proxy: meta.proxy, producer, accepted, relayed, rejected };
  console.log(`\n  largest request accepted   ${accepted ?? '-'} B`);
  console.log(`  largest Location relayed   ${relayed ?? '-'} B`);
  console.log(`  first request rejected     ${rejected ? `${rejected} B` : 'none'}`);
  console.log(`  json: ${writeEvidence(`escalate-${name.replace('/', '-')}-${producer}`, { summary, steps: rows })}`);
}

try {
  await main();
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  process.exitCode = 1;
} finally {
  down();
}
