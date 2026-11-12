import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { parseArgs } from 'node:util';
import {
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { values } = parseArgs({
  options: {
    runs: { type: 'string', default: '5' },
    output: { type: 'string' },
  },
});
const runs = Number(values.runs);
assert(
  Number.isSafeInteger(runs) && runs > 0,
  '--runs must be a positive integer',
);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = values.output
  ? resolve(values.output)
  : mkdtempSync(join(tmpdir(), 'hyperlane-solar-'));
mkdirSync(output, { recursive: true });
// Every invocation owns its build directories, even when reusing a report path.
const work = mkdtempSync(join(tmpdir(), 'hyperlane-solar-build-'));
const variants = ['solc', 'solar'];
const configs = {};
const artifacts = {};
const tests = {};
const results = {};

function run(command, args, env = process.env) {
  const start = performance.now();
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.signal,
    null,
    `${command} terminated by ${result.signal}`,
  );
  return { ...result, ms: performance.now() - start };
}

function checked(command, args) {
  const result = run(command, args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function envFor(variant) {
  return {
    ...process.env,
    FOUNDRY_PROFILE: variant === 'solar' ? 'solar' : 'default',
    FOUNDRY_OUT: join(work, variant, 'out'),
    FOUNDRY_CACHE_PATH: join(work, variant, 'cache'),
    // Match Foundry v1.5: tests submit and consume transient quotes in one tx.
    FOUNDRY_ISOLATE: 'false',
  };
}

function forge(variant, name, args, allowFailure = false) {
  const result = run('forge', args, envFor(variant));
  writeFileSync(join(output, `${variant}-${name}.stdout`), result.stdout);
  writeFileSync(join(output, `${variant}-${name}.stderr`), result.stderr);
  assert(
    allowFailure || result.status === 0,
    `${variant} ${name} failed; see ${output}`,
  );
  return result;
}

function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

// Ignore compiler-local AST/type IDs; preserve slot, offset and recursive type shape.
function storageShape(layout) {
  assert(layout, 'Compiler did not emit storageLayout');
  function typeShape(id, seen = new Set()) {
    const type = layout.types[id];
    assert(type, `Missing storage type ${id}`);
    if (seen.has(id)) return { recursive: type.label };
    const next = new Set([...seen, id]);
    return {
      label: type.label,
      encoding: type.encoding,
      bytes: type.numberOfBytes,
      base: type.base ? typeShape(type.base, next) : null,
      key: type.key ? typeShape(type.key, next) : null,
      value: type.value ? typeShape(type.value, next) : null,
      members: type.members?.map((m) => member(m, next)) ?? [],
    };
  }
  function member(m, seen) {
    return {
      label: m.label,
      slot: m.slot,
      offset: m.offset,
      type: typeShape(m.type, seen),
    };
  }
  return layout.storage.map((m) => member(m, new Set()));
}

function readArtifacts(variant) {
  const out = envFor(variant).FOUNDRY_OUT;
  const found = {};
  for (const path of globSync('**/*.json', { cwd: out })) {
    const artifact = JSON.parse(readFileSync(join(out, path), 'utf8'));
    const target = Object.entries(
      artifact.metadata?.settings?.compilationTarget ?? {},
    );
    if (target.length !== 1 || !target[0][0].startsWith('contracts/')) continue;
    const [source, contract] = target[0];
    // Forge also writes dependency artifacts for the size-optimized profile.
    // Compare its selected Contract.json, not whichever variant was read last.
    if (basename(path) !== `${contract}.json`) continue;
    found[`${source}:${contract}`] = {
      abi: artifact.abi.map((item) => JSON.stringify(canonical(item))).sort(),
      storage: storageShape(artifact.storageLayout),
      creationBytes: artifact.bytecode.object.replace(/^0x/, '').length / 2,
      runtimeBytes:
        artifact.deployedBytecode.object.replace(/^0x/, '').length / 2,
    };
  }
  assert(Object.keys(found).length > 0, `No ${variant} contract artifacts`);
  return found;
}

const report = {
  sourceCommit: checked('git', ['rev-parse', 'HEAD']),
  sourceDirty: checked('git', ['status', '--porcelain']).length > 0,
  measuredAt: new Date().toISOString(),
  host: {
    platform: platform(),
    release: release(),
    cpu: cpus()[0].model,
    threads: cpus().length,
    memoryBytes: totalmem(),
  },
  node: process.version,
  forge: checked('forge', ['--version']),
  solar: checked('solar', ['--version']),
  runs,
  method:
    'Alternating clean contracts-only builds (--force --skip test --skip script), then cached builds. Full offline test suite compiled separately; fixed fuzz seed 0, 50 runs. Wall times include Forge and artifact I/O. OS file caches are warm; dependency installation excluded. Test gas includes the harness, not isolated transaction gas.',
};
console.log(`Writing benchmark logs and report to ${output}`);
const buildArgs = [
  'build',
  '--skip',
  'test',
  '--skip',
  'script',
  '--extra-output',
  'storageLayout',
];
for (const variant of variants) {
  const config = forge(variant, 'config', ['config', '--json']);
  configs[variant] = JSON.parse(config.stdout);
  assert.equal(
    configs[variant].fuzz.runs,
    50,
    'Benchmark expects 50 fuzz runs',
  );
  results[variant] = { coldMs: [], cachedMs: [] };
}
assert.equal(configs.solc.solc, '0.8.33', 'Expected the pinned solc baseline');
assert.equal(configs.solar.solc, 'solar', 'Expected the Solar profile');
for (const key of [
  'evm_version',
  'optimizer',
  'optimizer_runs',
  'via_ir',
  'compilation_restrictions',
]) {
  assert.deepEqual(
    configs.solc[key],
    configs.solar[key],
    `Compiler settings differ: ${key}`,
  );
}
for (let i = 0; i < runs; i++) {
  for (const variant of i % 2 ? [...variants].reverse() : variants) {
    const cold = forge(variant, `cold-${i}`, [...buildArgs, '--force']);
    results[variant].coldMs.push(cold.ms);
    // Populate any supplemental profile artifacts before measuring a cache hit.
    forge(variant, `warmup-${i}`, buildArgs);
    const cached = forge(variant, `cached-${i}`, buildArgs);
    assert(
      !/^Compiling /m.test(cached.stdout),
      `${variant} cached build recompiled`,
    );
    results[variant].cachedMs.push(cached.ms);
    console.log(
      `${variant} ${i + 1}/${runs}: clean ${(cold.ms / 1000).toFixed(3)}s, cached ${(cached.ms / 1000).toFixed(3)}s`,
    );
  }
}
for (const variant of variants) {
  artifacts[variant] = readArtifacts(variant);
  for (const dir of ['aggregation', 'multisig'])
    mkdirSync(join(root, 'fixtures', dir), { recursive: true });
  const compile = forge(variant, 'test-build', [
    'build',
    '--extra-output',
    'storageLayout',
  ]);
  const test = forge(
    variant,
    'tests',
    [
      'test',
      '--json',
      '--extra-output',
      'storageLayout',
      '--no-match-contract',
      'Everclear|Tron|ForkTest',
      '--no-match-test',
      'testFork',
      '--fuzz-seed',
      '0',
    ],
    true,
  );
  const suites = JSON.parse(test.stdout);
  tests[variant] = {};
  const counts = {};
  const failures = [];
  for (const [suite, data] of Object.entries(suites)) {
    for (const [name, result] of Object.entries(data.test_results)) {
      const id = `${suite}:${name}`;
      tests[variant][id] = {
        status: result.status,
        reason: result.reason,
        kind: result.kind,
      };
      counts[result.status] = (counts[result.status] ?? 0) + 1;
      if (result.status === 'Failure')
        failures.push({ id, reason: result.reason });
    }
  }
  assert(Object.keys(tests[variant]).length > 0, `${variant} ran no tests`);
  results[variant] = {
    ...results[variant],
    coldMedianMs: median(results[variant].coldMs),
    cachedMedianMs: median(results[variant].cachedMs),
    testBuildMs: compile.ms,
    testMs: test.ms,
    testExitCode: test.status,
    counts,
    failures,
  };
  // A fixed unit test gives identical call inputs; fuzz dictionaries can differ
  // between compiler outputs even with the same seed.
  const gas = forge(variant, 'igp-gas', [
    'test',
    '--gas-report',
    '--json',
    '--extra-output',
    'storageLayout',
    '--match-contract',
    '^InterchainGasPaymasterTest$',
    '--match-test',
    '^testPayForGas\\(\\)$',
  ]);
  results[variant].igpGasReport = JSON.parse(gas.stdout);
}
const artifactIds = [
  ...new Set(variants.flatMap((v) => Object.keys(artifacts[v]))),
].sort();
const compatibility = [];
const sizes = [];
for (const id of artifactIds) {
  const baseline = artifacts.solc[id];
  const solar = artifacts.solar[id];
  if (!baseline || !solar) {
    compatibility.push({ id, missing: baseline ? 'solar' : 'solc' });
    continue;
  }
  const abiEqual = isDeepStrictEqual(baseline.abi, solar.abi);
  const storageEqual = isDeepStrictEqual(baseline.storage, solar.storage);
  if (!abiEqual || !storageEqual)
    compatibility.push({ id, abiEqual, storageEqual });
  sizes.push({
    id,
    solc: {
      creationBytes: baseline.creationBytes,
      runtimeBytes: baseline.runtimeBytes,
    },
    solar: {
      creationBytes: solar.creationBytes,
      runtimeBytes: solar.runtimeBytes,
    },
  });
}
const testIds = [
  ...new Set(variants.flatMap((v) => Object.keys(tests[v]))),
].sort();
const statusDifferences = testIds
  .filter((id) => tests.solc[id]?.status !== tests.solar[id]?.status)
  .map((id) => ({
    id,
    solc: tests.solc[id] ?? null,
    solar: tests.solar[id] ?? null,
  }));
// Keep every passing test's gas so readers can choose cases without rerunning.
const testGas = testIds
  .filter((id) => variants.every((v) => tests[v][id]?.status === 'Success'))
  .map((id) => ({
    id,
    solc: tests.solc[id].kind,
    solar: tests.solar[id].kind,
  }));
Object.assign(report, {
  configs,
  results,
  speedup: results.solc.coldMedianMs / results.solar.coldMedianMs,
  artifactCount: artifactIds.length,
  compatibility,
  sizes,
  statusDifferences,
  testGas,
});
writeFileSync(
  join(output, 'results.json'),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  `Clean build speedup: ${report.speedup.toFixed(2)}x; ABI/storage differences: ${compatibility.length}; test status differences: ${statusDifferences.length}`,
);
// Keep failures visible even when both compilers fail the same existing tests.
if (
  compatibility.length ||
  statusDifferences.length ||
  variants.some((v) => results[v].testExitCode !== 0)
)
  process.exitCode = 1;
