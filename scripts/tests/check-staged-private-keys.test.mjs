import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { scanPrivateKeys } from '../check-staged-private-keys.mjs';

const digest = 'a'.repeat(64);
const evm = 'b'.repeat(64);
const base58 = 'Z'.repeat(88);
const array = JSON.stringify(Array(64).fill(42));
const scan = (line) => scanPrivateKeys(`+++ b/config.yaml\n+${line}`);

for (const line of [
  `  imageDigest: sha256:${digest}`,
  `{"imageDigest": "sha256:${digest}"}`,
  `  image: ghcr.io/hyperlane-xyz/service@sha256:${digest}`,
  `{"image":"ghcr.io/team/service:v1@sha256:${digest}"}`,
  `FROM --platform=linux/amd64 node@sha256:${digest} AS build`,
]) {
  test(`accepts a public image digest: ${line.slice(0, 38)}`, () => {
    assert.deepEqual(scan(line), []);
  });
}

for (const line of [
  evm,
  `key: 0x${evm}`,
  `arbitrary: sha256:${digest}`,
  `imageDigest: ${digest}`,
  `imageDigest: sha512:${digest}`,
  `imageDigest: sha256:${digest} # ${evm}`,
  `{"imageDigest":"sha256:${digest}", "key":"${evm}"}`,
  `image: service@sha256:${digest} # ${base58}`,
  `imageDigest: sha256:${digest} # ${array}`,
  base58,
  array,
]) {
  test(`rejects key material outside a recognized digest (${line.length} characters)`, () => {
    assert.equal(scan(line).length, 1);
  });
}

test('ignores removed and context lines', () => {
  assert.deepEqual(scanPrivateKeys(`+++ b/a\n-${evm}\n ${evm}`), []);
});

test('scans the actual index and redacts diagnostics', () => {
  const directory = mkdtempSync(join(tmpdir(), 'staged-key-check-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: directory });
    git('init', '--quiet');
    const script = fileURLToPath(
      new URL('../check-staged-private-keys.mjs', import.meta.url),
    );
    writeFileSync(
      join(directory, 'config.yaml'),
      `imageDigest: sha256:${digest}\n`,
    );
    git('add', 'config.yaml');
    assert.equal(
      spawnSync(process.execPath, [script], { cwd: directory }).status,
      0,
    );
    writeFileSync(
      join(directory, 'config.yaml'),
      `imageDigest: sha256:${digest} # key: ${evm}\n`,
    );
    git('add', 'config.yaml');
    const result = spawnSync(process.execPath, [script], {
      cwd: directory,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /config.yaml: possible EVM private key/);
    assert.ok(!result.stderr.includes(evm));
    assert.ok(!result.stderr.includes(digest));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
