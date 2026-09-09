#!/usr/bin/env node
/* eslint-disable import/no-nodejs-modules */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROGRAMS } from './programs.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Production package closure; dev dependencies and disabled test-client features
 * do not contribute host-test crates to the fingerprint. Inline unit tests in
 * production source files remain conservatively included.
 */
export function productionSourceFiles() {
  const packages = new Map();
  for (const workspace of ['sealevel', 'main']) {
    const metadata = JSON.parse(
      execFileSync(
        'cargo',
        [
          'metadata',
          '--no-deps',
          '--format-version',
          '1',
          '--manifest-path',
          join(REPO_ROOT, 'rust', workspace, 'Cargo.toml'),
        ],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      ),
    );
    for (const pkg of metadata.packages)
      packages.set(dirname(pkg.manifest_path), pkg);
  }
  const binaries = new Set(
    Object.values(PROGRAMS).map((file) => file.slice(0, -3)),
  );
  const pending = [...packages.values()]
    .filter((pkg) =>
      pkg.targets.some((target) =>
        binaries.has(target.name.replaceAll('-', '_')),
      ),
    )
    .map((pkg) => [pkg, ['default']]);
  if (pending.length !== binaries.size)
    throw new Error('Missing embedded program packages');
  const featuresByPackage = new Map();
  while (pending.length) {
    const [pkg, requested] = pending.pop();
    const enabled = featuresByPackage.get(pkg.manifest_path) ?? new Set();
    if (
      featuresByPackage.has(pkg.manifest_path) &&
      requested.every((feature) => enabled.has(feature))
    )
      continue;
    featuresByPackage.set(pkg.manifest_path, enabled);
    const queue = [...requested];
    while (queue.length) {
      const feature = queue.pop();
      if (enabled.has(feature)) continue;
      enabled.add(feature);
      queue.push(...(pkg.features[feature] ?? []));
    }
    for (const dep of pkg.dependencies) {
      if (!dep.path || dep.kind === 'dev') continue;
      const name = dep.rename ?? dep.name;
      if (
        dep.optional &&
        !enabled.has(name) &&
        !enabled.has(`dep:${name}`) &&
        ![...enabled].some((feature) => feature.startsWith(`${name}/`))
      )
        continue;
      const target = packages.get(dep.path);
      if (!target)
        throw new Error(`Missing local production dependency: ${dep.path}`);
      const features = [
        ...dep.features,
        ...(dep.uses_default_features ? ['default'] : []),
      ];
      for (const feature of enabled) {
        if (feature.startsWith(`${name}/`))
          features.push(feature.slice(name.length + 1));
        if (feature.startsWith(`${name}?/`))
          features.push(feature.slice(name.length + 2));
      }
      pending.push([target, features]);
    }
  }
  const files = new Set([
    'rust/sealevel/Cargo.toml',
    'rust/sealevel/Cargo.lock',
    'rust/sealevel/rust-toolchain',
    'rust/sealevel/.cargo/config.toml',
    'rust/sealevel/programs/build-programs.sh',
    'rust/main/Cargo.toml',
    'typescript/svm-sdk/scripts/build-program-bytes.sh',
  ]);
  for (const manifest of featuresByPackage.keys()) {
    files.add(relative(REPO_ROOT, manifest));
    const sourceDir = join(dirname(manifest), 'src');
    for (const entry of readdirSync(sourceDir, { recursive: true })) {
      if (entry.endsWith('.rs'))
        files.add(relative(REPO_ROOT, join(sourceDir, entry)));
    }
  }
  return [...files].sort();
}

export function computeSealevelSourceHash() {
  const hash = createHash('sha256');
  for (const path of productionSourceFiles()) {
    hash.update(path);
    hash.update('\0');
    hash.update(readFileSync(join(REPO_ROOT, path)));
  }
  return hash.digest('hex');
}
