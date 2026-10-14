#!/usr/bin/env node
// Builds one image per app case in lab/apps, tagged ssr-redirect-poc:<case>.
//
//   node scripts/build.mjs             # every case
//   node scripts/build.mjs a1only      # one case
//
// NG_CLI and NG_FRAMEWORK in the environment override the pinned versions.

import { execFileSync } from 'node:child_process';

const CASES = ['full', 'a1only', 'amp'];

const selected = process.argv.slice(2);
for (const name of selected) {
  if (!CASES.includes(name)) {
    console.error(`unknown case "${name}", expected one of: ${CASES.join(', ')}`);
    process.exit(1);
  }
}

const versionArgs = ['NG_CLI', 'NG_FRAMEWORK']
  .filter((key) => process.env[key])
  .flatMap((key) => ['--build-arg', `${key}=${process.env[key]}`]);

for (const name of selected.length ? selected : CASES) {
  console.log(`\n=== ssr-redirect-poc:${name}`);
  execFileSync(
    'docker',
    ['build', '--build-arg', `CASE=${name}`, ...versionArgs, '-t', `ssr-redirect-poc:${name}`, 'lab/apps'],
    { stdio: 'inherit' },
  );
}
