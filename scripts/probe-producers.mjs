#!/usr/bin/env node
// Sends each producer's request straight to Node, no proxy in between, and
// prints the Location size it gets back. This is the Angular half of the
// finding; the topologies only decide what a proxy does with that header.
//
//   node scripts/probe-producers.mjs            # every case
//   node scripts/probe-producers.mjs a1only     # one case

import { execFileSync } from 'node:child_process';
import { rawGet, sleep, writeEvidence } from './lib.mjs';

const q = (n) => '"'.repeat(n);

const CASES = {
  full: {
    port: 14010,
    probes: [
      ['A1  router normalization', `/home/(x)?q=${q(1400)}`],
      ['A1  dot segment + matrix', `/.;/home?q=${q(1400)}`],
      ['A2  returnUrl guard', `/admin?q=${q(1000)}`],
      ['A3  functional redirectTo', `/legacy?q=${q(1400)}`],
      ['B1  redirect under :lang', `/${q(1400)}`],
      ['--  control, no redirect', `/home?q=${q(1400)}`],
    ],
  },
  a1only: {
    port: 14011,
    probes: [
      ['A1  router normalization', `/home/(x)?q=${q(1400)}`],
      ['A1  dot segment + matrix', `/.;/home?q=${q(1400)}`],
      ['A1  trailing empty segment', `/home/1//?q=${q(1400)}`],
      ['--  control, no redirect', `/home?q=${q(1400)}`],
    ],
  },
  amp: {
    port: 14012,
    probes: [
      ['returnUrl', `/amp-plain?q=${q(1000)}`],
      ['returnUrl, pre-encoded', `/amp-encoded?q=${q(1000)}`],
      ['returnUrl + next', `/amp-two-copies?q=${q(1000)}`],
      ['returnUrl + next, pre-encoded', `/amp-two-encoded?q=${q(1000)}`],
      // Node's default 16 KiB request-header limit is the ceiling.
      ['largest accepted request', `/amp-two-encoded?q=${q(16200)}`],
      ['--  over the limit', `/amp-two-encoded?q=${q(17000)}`],
    ],
  },
};

// X-Forwarded-Prefix is validated on its first comma-separated value only, but
// the whole header is prepended to the redirect. Needs the header trusted.
const PREFIX = {
  port: 14013,
  probes: [
    ['valid prefix', '/ok'],
    ['invalid prefix, rejected', '/ok!!bad'],
    ['valid first value, long tail', `/ok,${'B'.repeat(7900)}`],
    ['valid first value, quotes', `/ok,${q(200)}`],
  ],
};

// How many Location bytes each printable character becomes in the A1 query.
// `#` and `%` are left out, they end the target or start an escape.
async function charScan(port) {
  const groups = {};
  for (let code = 0x21; code <= 0x7e; code++) {
    const ch = String.fromCharCode(code);
    if (ch === '#' || ch === '%') continue;
    const r = await rawGet(port, `/home/(x)?q=${ch.repeat(100)}`);
    const key = r.status === 302 ? `${((r.locationBytes - '/home?q='.length) / 100).toFixed(2)}x` : `status ${r.status}`;
    (groups[key] ??= []).push(ch);
  }
  console.log('\n  bytes per character in the A1 query');
  for (const [key, chars] of Object.entries(groups).sort()) console.log(`  ${key.padEnd(10)} ${chars.join(' ')}`);
  return groups;
}

const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe' }).trim();

function start(name, image, port, env = []) {
  try {
    docker(['rm', '-f', name]);
  } catch {}
  docker(['run', '-d', '--name', name, '-p', `${port}:4000`, '-e', 'NG_ALLOWED_HOSTS=localhost', ...env, image]);
}

async function waitReady(port) {
  for (let i = 0; i < 60; i++) {
    if ((await rawGet(port, '/home')).status === 200) return true;
    await sleep(1000);
  }
  return false;
}

function row(label, r, byHeader) {
  const factor = r.locationBytes && !byHeader ? `${(r.locationBytes / r.requestBytes).toFixed(2)}x` : '-';
  console.log(
    `  ${label.padEnd(32)} ${String(r.requestBytes).padStart(6)} B  ${String(r.status).padEnd(4)}` +
      `  ${String(r.locationBytes).padStart(7)} B  ${factor.padStart(7)}`,
  );
}

async function runCase(name, { port, probes }, { image, headerName, env } = {}) {
  const container = `probe-${name}`;
  image ??= `ssr-redirect-poc:${name}`;
  console.log(`\n=== ${name} (${image})`);
  start(container, image, port, env);
  const records = [];
  try {
    if (!(await waitReady(port))) {
      console.log('  server never answered 200 on /home');
      return records;
    }
    console.log('  probe                             request  code  Location   factor');
    for (const [label, value] of probes) {
      // `/xx` hits the B1 redirect, whose target the prefix is prepended to.
      const r = headerName
        ? await rawGet(port, '/xx', { headers: `${headerName}: ${value}\r\n` })
        : await rawGet(port, value);
      row(label, r, Boolean(headerName));
      records.push({ case: name, probe: label, status: r.status, requestBytes: r.requestBytes, locationBytes: r.locationBytes });
    }
    if (name === 'a1only') records.push({ case: name, probe: 'chars', groups: await charScan(port) });
  } finally {
    try {
      docker(['rm', '-f', container]);
    } catch {}
  }
  return records;
}

const selected = process.argv.slice(2);
const records = [];
for (const [name, spec] of Object.entries(CASES)) {
  if (!selected.length || selected.includes(name)) records.push(...(await runCase(name, spec)));
}
if (!selected.length || selected.includes('prefix')) {
  records.push(
    ...(await runCase('prefix', PREFIX, {
      image: 'ssr-redirect-poc:full',
      headerName: 'X-Forwarded-Prefix',
      env: ['-e', 'NG_TRUST_PROXY_HEADERS=x-forwarded-prefix'],
    })),
  );
}

console.log(`\njson: ${writeEvidence('producers', { generatedUtc: new Date().toISOString(), records })}`);
