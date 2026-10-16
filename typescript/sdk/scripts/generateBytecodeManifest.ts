#!/usr/bin/env tsx
/* eslint-disable no-console */
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { assert } from '@hyperlane-xyz/utils';

import {
  type BytecodeManifest,
  type BytecodeManifestSet,
  type SolcBuildArtifact,
  generateManifestFromBuildArtifact,
} from '../src/deploy/verify/bytecodeManifest.js';

interface Args {
  versions: string[];
  out?: string;
}

interface SolcModule {
  compile(input: string): string;
}

function parseArgs(argv: string[]): Args {
  const versions: string[] = [];
  let out: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--version') {
      const version = argv[i + 1];
      assert(version, '--version requires a value');
      versions.push(version);
      i += 1;
      continue;
    }
    if (arg === '--out') {
      out = argv[i + 1];
      assert(out, '--out requires a value');
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument ${arg}`);
  }
  assert(versions.length > 0, 'At least one --version is required');
  return { versions, out };
}

function lastLine(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const line = lines[lines.length - 1];
  assert(line, 'Expected command output');
  return line;
}

function generateVersionManifest(version: string): BytecodeManifest {
  const tmpDir = mkdtempSync(join(tmpdir(), 'hyperlane-bytecode-manifest-'));
  try {
    writeFileSync(join(tmpDir, 'package.json'), '{"private":true}\n');
    const tarballName = lastLine(
      execFileSync('npm', ['pack', `@hyperlane-xyz/core@${version}`], {
        cwd: tmpDir,
        encoding: 'utf8',
      }),
    );
    execFileSync('tar', ['-xzf', join(tmpDir, tarballName), '-C', tmpDir]);
    const packageDir = join(tmpDir, 'package');
    const artifact = JSON.parse(
      readFileSync(join(packageDir, 'dist', 'buildArtifact.json'), 'utf8'),
    ) as SolcBuildArtifact;
    const solcVersion = artifact.solcLongVersion.split('+')[0];
    assert(solcVersion, `Invalid solcLongVersion ${artifact.solcLongVersion}`);
    execFileSync('npm', ['install', `solc@${solcVersion}`, '--no-save'], {
      cwd: tmpDir,
      stdio: 'inherit',
    });
    const requireFromTemp = createRequire(join(tmpDir, 'package.json'));
    const solc = requireFromTemp('solc') as SolcModule;
    return generateManifestFromBuildArtifact(artifact, version, (input) =>
      solc.compile(input),
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const manifestSet: BytecodeManifestSet = {};
  for (const version of args.versions) {
    manifestSet[version] = generateVersionManifest(version);
  }

  const json = `${JSON.stringify(manifestSet, null, 2)}\n`;
  if (args.out) {
    writeFileSync(resolve(args.out), json);
  } else {
    process.stdout.write(json);
  }
}

main();
