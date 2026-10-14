#!/usr/bin/env node
// Measures one or more topologies from lab/topologies/<proxy>/<name>/.
//
// Brings the stack up, sends legitimate requests at a steady rate while one
// oversized request goes out every second, counts how many legitimate requests
// still get 200, saves the proxy logs and tears everything down. Every
// topology goes through this same runner, so the numbers are comparable.
//
//   node scripts/run-topology.mjs nginx/explicit-2peers
//   node scripts/run-topology.mjs nginx/explicit-2peers --control
//   node scripts/run-topology.mjs haproxy          # every haproxy topology
//   node scripts/run-topology.mjs --all
//
// The H/D/N counters grep nginx error messages, so they are only meaningful
// for nginx, OpenResty and Kong. For the other proxies read their own log.

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { rawGet, sleep, writeEvidence } from './lib.mjs';

const execFileAsync = promisify(execFile);
const TOPOLOGIES = 'lab/topologies';

const argv = process.argv.slice(2);
const VALUED = ['warmup', 'duration', 'rps', 'attack-ms', 'up-timeout'];
const option = (key, fallback) => {
  const i = argv.indexOf(`--${key}`);
  return i === -1 ? fallback : Number(argv[i + 1]);
};
const positional = argv.filter(
  (arg, i) => !arg.startsWith('--') && !VALUED.includes(argv[i - 1]?.slice(2)),
);

const CONTROL = argv.includes('--control');
const WARMUP_S = option('warmup', 5);
const DURATION_S = option('duration', 25);
const LEGIT_RPS = option('rps', 10);
const ATTACK_MS = option('attack-ms', 1000);
const UP_TIMEOUT_S = option('up-timeout', 180);

const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

function listTopologies() {
  const found = [];
  for (const proxy of readdirSync(TOPOLOGIES, { withFileTypes: true })) {
    if (!proxy.isDirectory()) continue;
    for (const entry of readdirSync(join(TOPOLOGIES, proxy.name), { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(TOPOLOGIES, proxy.name, entry.name, 'meta.json'))) {
        found.push(`${proxy.name}/${entry.name}`);
      }
    }
  }
  return found.sort();
}

// --------------------------------------------------------------- compose --

const project = (name) => `poc-${name.replace('/', '-')}`;
const composeArgs = (name) => ['compose', '-p', project(name), '-f', join(TOPOLOGIES, name, 'compose.yml')];

function composeUp(name) {
  execFileSync('docker', [...composeArgs(name), 'up', '-d', '--remove-orphans'], { stdio: 'pipe' });
}

function composeDown(name) {
  try {
    execFileSync('docker', [...composeArgs(name), 'down', '-v', '--remove-orphans'], { stdio: 'pipe' });
  } catch {
    // Cleanup must not fail the measurement.
  }
}

async function composeLogs(name) {
  try {
    const { stdout, stderr } = await execFileAsync(
      'docker',
      [...composeArgs(name), 'logs', '--no-color', '--tail', '4000'],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    return `${stdout}\n${stderr}`;
  } catch (err) {
    return `(could not read logs: ${err.message})`;
  }
}

async function waitReady(meta) {
  const deadline = Date.now() + UP_TIMEOUT_S * 1000;
  let last = null;
  while (Date.now() < deadline) {
    const r = await rawGet(meta.port, meta.legitPath, { host: meta.hostHeader });
    if (r.status === 200) return;
    last = r.status ?? r.error;
    await sleep(1500);
  }
  throw new Error(`no 200 on ${meta.legitPath} (last: ${last})`);
}

// ----------------------------------------------------------- measurement --

async function measure(meta) {
  const { path, fill = '"', count = 1400 } = meta.attack;
  const target = path.replace('{payload}', fill.repeat(count));
  const legit = { warmup: { ok: 0, total: 0 }, attack: { ok: 0, total: 0 } };
  const attacker = { statuses: {}, total: 0, maxLocationBytes: 0 };
  let phase = 'warmup';
  let stop = false;

  const legitLoop = (async () => {
    const interval = 1000 / LEGIT_RPS;
    while (!stop) {
      const started = Date.now();
      const r = await rawGet(meta.port, meta.legitPath, { host: meta.hostHeader });
      legit[phase].total++;
      if (r.status === 200) legit[phase].ok++;
      const wait = interval - (Date.now() - started);
      if (wait > 0) await sleep(wait);
    }
  })();

  await sleep(WARMUP_S * 1000);
  log(`  warmup: ${legit.warmup.ok}/${legit.warmup.total} legitimate OK`);

  phase = 'attack';
  if (CONTROL) {
    log(`  control: ${DURATION_S}s without oversized requests`);
    await sleep(DURATION_S * 1000);
  } else {
    log(`  ${target.length} B request every ${ATTACK_MS} ms for ${DURATION_S}s`);
    const end = Date.now() + DURATION_S * 1000;
    while (Date.now() < end) {
      const r = await rawGet(meta.port, target, { host: meta.hostHeader });
      attacker.total++;
      const key = String(r.status ?? r.error);
      attacker.statuses[key] = (attacker.statuses[key] ?? 0) + 1;
      attacker.maxLocationBytes = Math.max(attacker.maxLocationBytes, r.locationBytes);
      await sleep(ATTACK_MS);
    }
  }

  // Time until a legitimate request succeeds again once the requests stop.
  let recoverySeconds = null;
  if (!CONTROL && legit.attack.ok < legit.attack.total) {
    const started = Date.now();
    for (let i = 0; i < 60; i++) {
      const r = await rawGet(meta.port, meta.legitPath, { host: meta.hostHeader });
      if (r.status === 200) {
        recoverySeconds = Number(((Date.now() - started) / 1000).toFixed(1));
        break;
      }
      await sleep(1000);
    }
  }

  stop = true;
  await legitLoop;

  return {
    legitSuccessDuringAttack: `${legit.attack.ok}/${legit.attack.total}`,
    legitSuccessPct: legit.attack.total
      ? Number(((legit.attack.ok / legit.attack.total) * 100).toFixed(1))
      : null,
    warmup: `${legit.warmup.ok}/${legit.warmup.total}`,
    attacker,
    attackRequestBytes: target.length,
    recoverySeconds,
  };
}

function nginxSignals(text) {
  const count = (re) => (text.match(re) ?? []).length;
  return {
    H_tooBigHeader: count(/upstream sent too big header/g),
    D_peerDisabled: count(/upstream server temporarily disabled/g),
    N_noLiveUpstreams: count(/no live upstreams/g),
    C_connRefused: count(/connect\(\) failed \(111: Connection refused\)/g),
  };
}

async function runOne(name) {
  const meta = JSON.parse(readFileSync(join(TOPOLOGIES, name, 'meta.json'), 'utf8'));
  meta.legitPath ??= '/home';
  meta.hostHeader ??= 'localhost';
  log(`${name} (${meta.proxy}, port ${meta.port}, ${CONTROL ? 'control' : 'attack'})`);

  const started = new Date().toISOString();
  let result = null;
  let logs = '';
  let error = null;

  composeDown(name);
  try {
    composeUp(name);
    await waitReady(meta);
    result = await measure(meta);
    logs = await composeLogs(name);
  } catch (err) {
    error = err.message;
    logs = await composeLogs(name);
  } finally {
    composeDown(name);
  }

  const doc = {
    topology: name,
    mode: CONTROL ? 'control' : 'attack',
    description: meta.description,
    proxy: meta.proxy,
    proxyVersion: meta.proxyVersion,
    producer: meta.producer,
    expect: meta.expect,
    startedUtc: started,
    finishedUtc: new Date().toISOString(),
    params: { warmupSeconds: WARMUP_S, durationSeconds: DURATION_S, legitRps: LEGIT_RPS, attackIntervalMs: ATTACK_MS },
    error,
    result,
    nginxSignals: nginxSignals(logs),
  };

  const file = writeEvidence(`topology-${name.replace('/', '-')}-${doc.mode}`, doc);
  writeFileSync(file.replace(/\.json$/, '.log'), logs, 'utf8');

  if (error) {
    log(`  ERROR: ${error}`);
  } else {
    const s = doc.nginxSignals;
    log(`  legitimate: ${result.legitSuccessDuringAttack} (${result.legitSuccessPct}%)`);
    log(`  oversized: ${JSON.stringify(result.attacker.statuses)}, Location up to ${result.attacker.maxLocationBytes} B`);
    log(`  nginx H=${s.H_tooBigHeader} D=${s.D_peerDisabled} N=${s.N_noLiveUpstreams} C=${s.C_connRefused}`);
    if (result.recoverySeconds != null) log(`  recovered after ${result.recoverySeconds}s`);
  }
  log(`  json: ${file}`);
  return doc;
}

// ------------------------------------------------------------------ main --

const available = listTopologies();
const selected = argv.includes('--all')
  ? available
  : positional.flatMap((arg) => (arg.includes('/') ? [arg] : available.filter((n) => n.startsWith(`${arg}/`))));

const unknown = selected.filter((name) => !available.includes(name));
if (!selected.length || unknown.length) {
  if (unknown.length) console.error(`unknown topology: ${unknown.join(', ')}`);
  console.error('usage: node scripts/run-topology.mjs <proxy>[/<name>] ... [--control] | --all');
  console.error(`available:\n  ${available.join('\n  ')}`);
  process.exit(1);
}

const summary = [];
for (const name of selected) summary.push(await runOne(name));

console.log('\ntopology                        proxy       expect     legit     H    D    N');
for (const d of summary) {
  const s = d.nginxSignals;
  const legit = d.error ? 'ERROR' : `${d.result.legitSuccessPct}%`;
  console.log(
    `${d.topology.padEnd(30)}  ${String(d.proxy).padEnd(10)}  ${String(d.expect).padEnd(9)}  ${legit.padEnd(8)}` +
      `  ${String(s.H_tooBigHeader).padStart(3)}  ${String(s.D_peerDisabled).padStart(3)}  ${String(s.N_noLiveUpstreams).padStart(3)}`,
  );
}
