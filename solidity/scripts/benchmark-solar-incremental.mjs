import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    runs: { type: 'string', default: '5' },
    output: { type: 'string' },
  },
});
const runs = Number(values.runs);
assert(Number.isSafeInteger(runs) && runs > 0);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = values.output
  ? resolve(values.output)
  : mkdtempSync(join(tmpdir(), 'hyperlane-incremental-'));
mkdirSync(output, { recursive: true });
const project = mkdtempSync(join(tmpdir(), 'hyperlane-source-copy-'));
// All invalidations affect a task-owned source copy, never the checkout.
cpSync(join(root, 'contracts'), join(project, 'contracts'), {
  recursive: true,
});
for (const name of ['foundry.toml', 'remappings.txt'])
  copyFileSync(join(root, name), join(project, name));
symlinkSync(join(root, 'dependencies'), join(project, 'dependencies'), 'dir');
mkdirSync(join(project, 'lib'));
const variants = ['solc', 'solar'];
const args = ['build', '--skip', 'test', '--skip', 'script'];
function run(variant, name, extra = []) {
  const env = {
    ...process.env,
    FOUNDRY_PROFILE: variant === 'solar' ? 'solar' : 'default',
    FOUNDRY_OUT: join(project, `${variant}-out`),
    FOUNDRY_CACHE_PATH: join(project, `${variant}-cache`),
  };
  const start = performance.now();
  const result = spawnSync('forge', [...args, ...extra], {
    cwd: project,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  writeFileSync(join(output, `${variant}-${name}.stdout`), result.stdout);
  writeFileSync(join(output, `${variant}-${name}.stderr`), result.stderr);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return {
    ms: performance.now() - start,
    compiles: [...result.stdout.matchAll(/Compiling (\d+) files/g)].map((x) =>
      Number(x[1]),
    ),
  };
}
const report = {
  method:
    'Comment-only invalidations in a temporary contracts-only project copy with the same remappings/dependencies/profiles. No checkout files modified. Clean initial compilation and a stabilization pass excluded from incremental medians. Alternating variant order. Native Forge compilation, not package exports.',
  runs,
  cases: {},
};
for (const v of variants) {
  run(v, 'initial', ['--force']);
  run(v, 'stabilize');
}
for (const [label, path] of [
  ['leaf-hook', 'contracts/hooks/MerkleTreeHook.sol'],
  ['shared-router', 'contracts/client/Router.sol'],
]) {
  const file = join(project, path),
    original = readFileSync(file, 'utf8');
  report.cases[label] = { path, solc: [], solar: [] };
  for (let i = 0; i < runs; i++) {
    writeFileSync(
      file,
      `${original}\n// benchmark invalidation ${label} ${i}\n`,
    );
    for (const v of i % 2 ? [...variants].reverse() : variants) {
      const result = run(v, `${label}-${i}`);
      assert(result.compiles.length > 0, 'Invalidation did not compile');
      report.cases[label][v].push(result);
    }
  }
  // Restore and stabilize before the next independent invalidation case.
  writeFileSync(file, original);
  for (const v of variants) run(v, `${label}-restore`);
}
writeFileSync(
  join(output, 'results.json'),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(output);
