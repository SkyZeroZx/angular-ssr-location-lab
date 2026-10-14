#!/usr/bin/env node
// Removes containers and networks left by an interrupted run. Only names this
// lab creates are touched: poc-* (topologies), esc-* (escalate), thr-*
// (threshold) and probe-* (probe-producers).

import { execFileSync } from 'node:child_process';

const PREFIX = /^(poc|esc|thr|probe)-/;
const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe' }).trim();
const list = (args) => docker(args).split('\n').filter((name) => PREFIX.test(name));

const containers = list(['ps', '-a', '--format', '{{.Names}}']);
if (containers.length) docker(['rm', '-f', ...containers]);

const networks = list(['network', 'ls', '--format', '{{.Name}}']);
if (networks.length) docker(['network', 'rm', ...networks]);

console.log(`removed ${containers.length} containers, ${networks.length} networks`);
