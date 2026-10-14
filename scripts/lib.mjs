// Helpers shared by the scripts. Everything here talks to 127.0.0.1 only.

import net from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const EVIDENCE_DIR = 'ssr-redirect-evidence';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET over a raw socket, so the request-target goes out byte for byte.
 * fetch() and node:http would percent-encode it first, which hides the
 * expansion this lab measures.
 */
export function rawGet(port, target, { host = 'localhost', headers = '', timeout = 15000 } = {}) {
  const targetBuf = Buffer.isBuffer(target) ? target : Buffer.from(target, 'latin1');
  const request = Buffer.concat([
    Buffer.from('GET ', 'latin1'),
    targetBuf,
    Buffer.from(` HTTP/1.1\r\nHost: ${host}\r\n${headers}Connection: close\r\n\r\n`, 'latin1'),
  ]);

  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(timeout);

    const finish = (err) => {
      if (done) return;
      done = true;
      socket.destroy();
      const raw = Buffer.concat(chunks).toString('latin1');
      const end = raw.indexOf('\r\n\r\n');
      const head = end === -1 ? raw : raw.slice(0, end);
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(head);
      const location = /\r\nlocation:[ \t]*([^\r\n]*)/i.exec(head)?.[1] ?? '';
      resolve({
        status: status ? Number(status[1]) : null,
        location,
        locationBytes: Buffer.byteLength(location, 'latin1'),
        requestBytes: targetBuf.length,
        headBytes: Buffer.byteLength(head, 'latin1'),
        error: err ? String(err.message ?? err) : raw ? null : 'empty response',
      });
    };

    socket.on('connect', () => socket.write(request));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => finish());
    socket.on('close', () => finish());
    socket.on('timeout', () => finish(new Error('timeout')));
    socket.on('error', (err) => finish(err));
  });
}

/** Writes a JSON record into ssr-redirect-evidence/ and returns its path. */
export function writeEvidence(name, data) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const file = join(EVIDENCE_DIR, `${name}-${stamp}.json`);
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  return file;
}
