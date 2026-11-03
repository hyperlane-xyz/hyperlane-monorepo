#!/usr/bin/env node
// Run with Node 26. This compiles git snapshots, not copied algorithms.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const DEFAULT_BASELINE = '7e80c603f0278c9b1f0555fe0106279e2df5f070';
const DEFAULT_PROPOSED = 'd555ffbfd7d82438851e6f848ea7dfc28b2e336d';
const PACKAGES = ['utils', 'sdk', 'rebalancer'];
const COMPARED_FILES = [
  'typescript/utils/src/async.ts',
  'typescript/sdk/src/providers/transactionFeeEstimators.ts',
  'typescript/rebalancer/src/monitor/Monitor.ts',
];
const ADDRESS = '0x0000000000000000000000000000000000000001';
const HASH = `0x${'01'.repeat(32)}`;

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

export function snapshot(ref, destination) {
  const commit = git('rev-parse', `${ref}^{commit}`);
  const paths = PACKAGES.flatMap((name) => [
    `typescript/${name}/src`,
    `typescript/${name}/package.json`,
    `typescript/${name}/tsconfig.json`,
  ]);
  mkdirSync(destination, { recursive: true });
  paths.push('typescript/utils/tsconfig.build.json');
  const archive = execFileSync('git', ['archive', commit, ...paths], {
    cwd: ROOT,
    maxBuffer: 128 * 1024 * 1024,
  });
  execFileSync('tar', ['-xf', '-', '-C', destination], { input: archive });

  for (const name of PACKAGES) {
    const packageRoot = join(destination, 'typescript', name);
    const modules = join(packageRoot, 'node_modules');
    mkdirSync(modules);
    const installed = join(ROOT, 'typescript', name, 'node_modules');
    for (const entry of readdirSync(installed)) {
      if (entry === '@hyperlane-xyz') continue;
      symlinkSync(join(installed, entry), join(modules, entry));
    }
    const scope = join(modules, '@hyperlane-xyz');
    mkdirSync(scope);
    for (const entry of readdirSync(join(installed, '@hyperlane-xyz'))) {
      const target = PACKAGES.includes(entry)
        ? join(destination, 'typescript', entry)
        : join(installed, '@hyperlane-xyz', entry);
      symlinkSync(target, join(scope, entry));
    }
  }
  for (const name of PACKAGES) {
    const packageRoot = join(destination, 'typescript', name);
    const config =
      name === 'utils'
        ? { extends: './tsconfig.build.json' }
        : name === 'sdk'
          ? {
              extends: './tsconfig.json',
              exclude: ['./src/**/*.test.ts', './src/**/*.hardhat-test.ts'],
            }
          : {
              extends: './tsconfig.json',
              files: ['./src/monitor/Monitor.ts'],
              include: [],
            };
    const configPath = join(packageRoot, 'tsconfig.benchmark.json');
    writeFileSync(configPath, JSON.stringify(config));
    process.stderr.write(`Compiling ${commit.slice(0, 8)} ${name} source\n`);
    execFileSync(
      join(ROOT, 'node_modules/.bin/tsc'),
      ['--project', configPath],
      {
        cwd: packageRoot,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
  }
  return {
    commit,
    directory: destination,
    files: Object.fromEntries(
      COMPARED_FILES.map((file) => [
        file,
        {
          git_blob: git('rev-parse', `${commit}:${file}`),
          sha256_base64: createHash('sha256')
            .update(readFileSync(join(destination, file)))
            .digest('base64'),
          compiled_sha256_base64: createHash('sha256')
            .update(
              readFileSync(
                join(
                  destination,
                  file.replace('/src/', '/dist/').replace(/\.ts$/, '.js'),
                ),
              ),
            )
            .digest('base64'),
        },
      ]),
    ),
  };
}

class Meter {
  calls = 0;
  providerCalls = 0;
  active = 0;
  peak = 0;
  apiElapsedMs = 0;
  failures = 0;
  idleWaiters = [];

  reset() {
    assert.equal(this.active, 0, 'previous sample left pending operations');
    this.calls =
      this.providerCalls =
      this.peak =
      this.apiElapsedMs =
      this.failures =
        0;
  }

  async request(delayMs, providerCall, value) {
    this.calls++;
    if (providerCall) this.providerCalls++;
    this.peak = Math.max(this.peak, ++this.active);
    try {
      if (delayMs > 0) await new Promise((done) => setTimeout(done, delayMs));
      else await Promise.resolve();
      return value();
    } finally {
      this.active--;
      if (this.active === 0) {
        for (const done of this.idleWaiters.splice(0)) done();
      }
    }
  }

  async drain() {
    if (this.active > 0)
      await new Promise((done) => this.idleWaiters.push(done));
  }
}

async function loadVersion(source) {
  const load = (path) =>
    import(pathToFileURL(join(source.directory, path)).href);
  const [asyncModule, fees, monitorModule, events, sdk, utils] =
    await Promise.all([
      load('typescript/utils/dist/async.js'),
      load('typescript/sdk/dist/providers/transactionFeeEstimators.js'),
      load('typescript/rebalancer/dist/monitor/Monitor.js'),
      load('typescript/rebalancer/dist/interfaces/IMonitor.js'),
      load('typescript/sdk/dist/index.js'),
      load('typescript/utils/dist/index.js'),
    ]);
  assert.equal(
    asyncModule.concurrentMap,
    utils.concurrentMap,
    'workspace imports must use the compared utility version',
  );
  const require = createRequire(
    join(source.directory, 'typescript/sdk/package.json'),
  );
  const { BigNumber, providers } = require('ethers');
  const pino = require('pino');
  const logger = pino({ level: 'silent' });

  function ethersProvider(meter, delayMs, failSimulation = false) {
    const provider = new providers.JsonRpcProvider('http://unused.invalid', {
      name: 'controlled',
      chainId: 1,
    });
    provider.estimateGas = () =>
      meter.request(delayMs, true, () => {
        if (failSimulation) throw new Error('controlled simulation failure');
        return BigNumber.from(21_000);
      });
    provider.getFeeData = () =>
      meter.request(failSimulation ? 8 : delayMs, true, () => ({
        gasPrice: BigNumber.from(2),
        lastBaseFeePerGas: null,
        maxFeePerGas: null,
        maxPriorityFeePerGas: null,
      }));
    return provider;
  }

  function monitorFixture(count, delayMs, meter) {
    const metadata = {};
    const tokens = Array.from({ length: count }, (_, index) => {
      const chainName = `chain${index}`;
      metadata[chainName] = {
        name: chainName,
        protocol: utils.ProtocolType.Ethereum,
        chainId: index + 1,
        domainId: index + 1,
        rpcUrls: [{ http: 'http://unused.invalid' }],
        blocks: { reorgPeriod: 2, confirmations: 1 },
      };
      return new sdk.Token({
        chainName,
        standard: sdk.TokenStandard.EvmHypSynthetic,
        addressOrDenom: ADDRESS,
        decimals: 18,
        name: 'Token',
        symbol: 'TOK',
      });
    });
    const multiProvider = new sdk.MultiProtocolProvider(metadata);
    const blocks = tokens.map(() => {
      const provider = new providers.JsonRpcProvider('http://unused.invalid', {
        name: 'controlled',
        chainId: 1,
      });
      provider.send = (method) => {
        assert.equal(method, 'eth_blockNumber');
        return meter.request(delayMs, true, () => '0x64');
      };
      return provider;
    });
    multiProvider.getEthersV5Provider = (chain) => {
      const index = tokens.findIndex((token) => token.chainName === chain);
      assert.ok(index >= 0);
      return blocks[index];
    };
    tokens.forEach((token, index) => {
      const adapter = {
        getBridgedSupply: ({ blockTag } = {}) => {
          assert.equal(blockTag, 98);
          return meter.request(delayMs, true, () => BigInt(index));
        },
        getBalance: () =>
          meter.request(delayMs, true, () => BigInt(index + 10)),
      };
      token.getHypAdapter = () => adapter;
      token.getAdapter = () => adapter;
    });
    const warpCore = new sdk.WarpCore(multiProvider, tokens);
    return async () => {
      const monitor = new monitorModule.Monitor(0, warpCore, logger, {
        chains: tokens.map((token) => token.chainName),
        inventoryAddresses: { [utils.ProtocolType.Ethereum]: ADDRESS },
      });
      let received = 0;
      monitor.on(events.MonitorEventType.TokenInfo, (event) => {
        received++;
        assert.equal(event.tokensInfo.length, count);
        event.tokensInfo.forEach(({ token, bridgedSupply }, index) => {
          assert.equal(token, tokens[index]);
          assert.equal(bridgedSupply, BigInt(index));
          assert.equal(
            event.inventoryBalances[token.chainName],
            BigInt(index + 10),
          );
        });
        void monitor.stop();
      });
      monitor.on(events.MonitorEventType.Error, (error) => {
        throw error;
      });
      await monitor.start();
      assert.equal(received, 1);
    };
  }

  function prepare(scenario) {
    const meter = new Meter();
    let operation;
    if (scenario.kind === 'map') {
      const input = Array.from({ length: scenario.items }, (_, index) => index);
      operation = async () => {
        const mapper = scenario.immediate
          ? async (value) => {
              meter.calls++;
              return value * 2;
            }
          : (value) =>
              meter.request(
                scenario.stragglers && value % scenario.stragglerEvery === 0
                  ? scenario.stragglerDelayMs
                  : scenario.delayMs,
                false,
                () => value * 2,
              );
        const result = await asyncModule.concurrentMap(
          scenario.concurrency,
          input,
          mapper,
        );
        assert.equal(result.length, scenario.items);
        for (let index = 0; index < result.length; index++)
          assert.equal(result[index], index * 2);
      };
    } else if (scenario.kind === 'ethers') {
      const provider = ethersProvider(
        meter,
        scenario.delayMs,
        scenario.failure,
      );
      operation = async () => {
        const apiStart = performance.now();
        try {
          const result = await fees.estimateTransactionFeeEthersV5({
            transaction: { to: ADDRESS },
            provider,
            sender: ADDRESS,
          });
          assert.ok(!scenario.failure, 'expected controlled failure');
          assert.equal(result.fee, 42_000n);
        } catch (error) {
          if (
            !scenario.failure ||
            error.message !== 'controlled simulation failure'
          )
            throw error;
          meter.failures++;
        } finally {
          meter.apiElapsedMs += performance.now() - apiStart;
        }
        // The failure workload measures resource quiescence as well as API latency.
        // Promise.all may return while a sibling read remains in flight.
        await meter.drain();
      };
    } else if (scenario.kind === 'viem') {
      const provider = {
        provider: {
          estimateGas: () =>
            meter.request(scenario.delayMs, true, () => 21_000n),
          estimateFeesPerGas: () =>
            meter.request(scenario.delayMs, true, () => ({ gasPrice: 2n })),
        },
      };
      const transaction = {
        blockHash: HASH,
        blockNumber: 1n,
        from: ADDRESS,
        gas: 21_000n,
        gasPrice: 2n,
        hash: HASH,
        input: '0x',
        nonce: 0,
        r: '0x',
        s: '0x',
        to: ADDRESS,
        transactionIndex: 0,
        type: 'legacy',
        typeHex: '0x0',
        v: 27n,
        value: 0n,
      };
      operation = async () => {
        const result = await fees.estimateTransactionFeeViem({
          transaction: { transaction },
          provider,
          sender: ADDRESS,
        });
        assert.equal(result.fee, 42_000n);
      };
    } else {
      operation = monitorFixture(scenario.chains, scenario.delayMs, meter);
    }
    return { meter, operation };
  }
  return { source, prepare };
}

const SCENARIOS = [
  {
    id: 'map_uniform',
    kind: 'map',
    items: 64,
    concurrency: 8,
    iterations: 1,
    delayMs: 2,
  },
  {
    id: 'map_stragglers',
    kind: 'map',
    items: 64,
    concurrency: 8,
    iterations: 1,
    stragglers: true,
    delayMs: 2,
    stragglerDelayMs: 20,
    stragglerEvery: 16,
  },
  {
    id: 'map_no_io',
    kind: 'map',
    items: 1024,
    concurrency: 8,
    iterations: 50,
    immediate: true,
  },
  { id: 'ethers_delay', kind: 'ethers', iterations: 4, delayMs: 8 },
  { id: 'ethers_no_io', kind: 'ethers', iterations: 100, delayMs: 0 },
  { id: 'viem_delay', kind: 'viem', iterations: 4, delayMs: 8 },
  {
    id: 'ethers_failed_simulation',
    kind: 'ethers',
    iterations: 4,
    delayMs: 2,
    failure: true,
  },
  {
    id: 'monitor_8_chains',
    kind: 'monitor',
    chains: 8,
    iterations: 1,
    delayMs: 2,
  },
  {
    id: 'monitor_32_chains',
    kind: 'monitor',
    chains: 32,
    iterations: 1,
    delayMs: 2,
  },
  {
    id: 'monitor_no_io',
    kind: 'monitor',
    chains: 32,
    iterations: 10,
    delayMs: 0,
  },
];

async function measure(prepared, scenario, repetition, version) {
  prepared.meter.reset();
  const beforeMemory = process.memoryUsage();
  const beforeCpu = process.cpuUsage();
  const start = performance.now();
  for (let iteration = 0; iteration < scenario.iterations; iteration++)
    await prepared.operation();
  const elapsedMs = performance.now() - start;
  const cpu = process.cpuUsage(beforeCpu);
  const memory = process.memoryUsage();
  assert.equal(prepared.meter.active, 0);
  assert.equal(
    prepared.meter.failures,
    scenario.failure ? scenario.iterations : 0,
  );
  return {
    version,
    repetition,
    elapsed_ms: elapsedMs,
    latency_ms: elapsedMs / scenario.iterations,
    operations: scenario.iterations,
    cpu_user_ms: cpu.user / 1000,
    cpu_system_ms: cpu.system / 1000,
    cpu_ms_per_operation: (cpu.user + cpu.system) / 1000 / scenario.iterations,
    rss_before_bytes: beforeMemory.rss,
    rss_after_bytes: memory.rss,
    heap_used_after_bytes: memory.heapUsed,
    async_operations: prepared.meter.calls,
    provider_calls: prepared.meter.providerCalls,
    peak_inflight: scenario.immediate ? null : prepared.meter.peak,
    api_latency_ms:
      scenario.kind === 'ethers'
        ? prepared.meter.apiElapsedMs / scenario.iterations
        : null,
    expected_failures: prepared.meter.failures,
  };
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(samples) {
  const totalElapsedMs = samples.reduce(
    (sum, sample) => sum + sample.elapsed_ms,
    0,
  );
  const operations = samples.reduce(
    (sum, sample) => sum + sample.operations,
    0,
  );
  const first = samples[0];
  return {
    samples: samples.length,
    p50_ms: percentile(
      samples.map((sample) => sample.latency_ms),
      0.5,
    ),
    p95_ms: percentile(
      samples.map((sample) => sample.latency_ms),
      0.95,
    ),
    operations_per_second: (operations * 1000) / totalElapsedMs,
    p50_cpu_ms: percentile(
      samples.map((sample) => sample.cpu_ms_per_operation),
      0.5,
    ),
    p95_cpu_ms: percentile(
      samples.map((sample) => sample.cpu_ms_per_operation),
      0.95,
    ),
    provider_calls_per_operation:
      samples.reduce((sum, sample) => sum + sample.provider_calls, 0) /
      operations,
    async_operations_per_operation:
      samples.reduce((sum, sample) => sum + sample.async_operations, 0) /
      operations,
    peak_inflight:
      first.peak_inflight === null
        ? null
        : Math.max(...samples.map((sample) => sample.peak_inflight)),
    p50_api_latency_ms:
      first.api_latency_ms === null
        ? null
        : percentile(
            samples.map((sample) => sample.api_latency_ms),
            0.5,
          ),
  };
}

function markdown(result) {
  const rows = result.workloads.map((workload) => {
    const baseline = workload.summaries.baseline;
    const proposed = workload.summaries.proposed;
    const peaks = `${baseline.peak_inflight ?? 'n/a'}/${proposed.peak_inflight ?? 'n/a'}`;
    return `| ${workload.id}${workload.failure ? ' (quiescent)' : ''} | ${baseline.p50_ms.toFixed(3)} | ${proposed.p50_ms.toFixed(3)} | ${baseline.p95_ms.toFixed(3)} | ${proposed.p95_ms.toFixed(3)} | ${workload.p50_speedup.toFixed(2)}x | ${baseline.operations_per_second.toFixed(0)}/${proposed.operations_per_second.toFixed(0)} | ${baseline.p50_cpu_ms.toFixed(3)}/${proposed.p50_cpu_ms.toFixed(3)} | ${baseline.provider_calls_per_operation}/${proposed.provider_calls_per_operation} | ${peaks} |`;
  });
  const failed = result.workloads.find((workload) => workload.failure);
  return [
    '# TypeScript source comparison: measured results',
    '',
    `Baseline: ${result.sources.baseline.commit}. Proposed: ${result.sources.proposed.commit}.`,
    '',
    `Node ${result.environment.node}; ${result.environment.cpu_model}; ${result.method.warmups} warmups and ${result.method.repetitions} measured rounds/version/workload. Controlled synthetic delays, not production traffic. B/P = baseline/proposed.`,
    '',
    '| Workload | B p50 ms | P p50 ms | B p95 ms | P p95 ms | p50 speedup | Workloads/s B/P | CPU ms/workload B/P | Provider calls/workload B/P | Peak active B/P |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows,
    '',
    'Map throughput counts complete maps, fee throughput counts estimates, Monitor throughput counts cycles. Multi-iteration samples report per-workload averages. CPU includes harness counters and validation. Map peak counts mapper tasks; other peaks count controlled provider-boundary reads. Provider calls are stub invocations; real getFeeData may issue multiple wire RPCs.',
    '',
    ...(failed
      ? [
          `Failed-simulation API p50: baseline ${failed.summaries.baseline.p50_api_latency_ms.toFixed(3)} ms, proposed ${failed.summaries.proposed.p50_api_latency_ms.toFixed(3)} ms. Its table row measures time until all initiated reads settle, exposing the proposed implementation's additional fee-data read after simulation failure.`,
          '',
        ]
      : []),
    `Shared-process peak RSS: ${(result.process_peak_rss_kib / 1024).toFixed(1)} MiB. Both source versions are imported in one process; RSS is not an independent per-version memory comparison. This peak includes snapshot preparation/imports. Raw samples retain RSS observations, CPU deltas, counters and source digests.`,
    '',
  ].join('\n');
}

async function main() {
  assert.equal(
    process.versions.node,
    '26.12.1',
    'Use repository-pinned Node 26.12.1',
  );
  const warmups = Number(option('--warmups', '5'));
  const repetitions = Number(option('--repetitions', '41'));
  assert.ok(Number.isInteger(warmups) && warmups >= 0);
  assert.ok(Number.isInteger(repetitions) && repetitions > 0);
  const selected = option('--scenario', 'all');
  const scenarios = SCENARIOS.filter(
    (scenario) => selected === 'all' || scenario.id === selected,
  );
  assert.ok(scenarios.length > 0, `Unknown scenario: ${selected}`);
  const output = resolve(
    option(
      '--output',
      join(dirname(fileURLToPath(import.meta.url)), 'results.json'),
    ),
  );
  const temporary = mkdtempSync(join(tmpdir(), 'hm1-ts-hotpaths-'));
  try {
    const sources = {
      baseline: snapshot(
        option('--baseline', DEFAULT_BASELINE),
        join(temporary, 'baseline'),
      ),
      proposed: snapshot(
        option('--proposed', DEFAULT_PROPOSED),
        join(temporary, 'proposed'),
      ),
    };
    const versions = {};
    for (const [version, source] of Object.entries(sources)) {
      process.stderr.write(`Loading ${version}: ${source.commit}\n`);
      versions[version] = await loadVersion(source);
    }
    if (process.argv.includes('--prepare-only')) {
      process.stderr.write(
        'Both exact source snapshots imported successfully; no measurements run.\n',
      );
      return;
    }
    const result = {
      generated_at: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: platform(),
        os_release: release(),
        arch: process.arch,
        cpu_model: cpus()[0].model,
        logical_cpus: cpus().length,
        system_memory_bytes: totalmem(),
        typescript_compiler: JSON.parse(
          readFileSync(
            join(ROOT, 'node_modules/@typescript/native/package.json'),
            'utf8',
          ),
        ).version,
        pnpm_lock_sha256_base64: createHash('sha256')
          .update(readFileSync(join(ROOT, 'pnpm-lock.yaml')))
          .digest('base64'),
      },
      method: {
        workload:
          'Synthetic timer/stub-controlled I/O; no production or remote RPC measurements',
        source:
          'git archive of exact versioned utils/sdk/rebalancer source, compiled with the repository TypeScript compiler into per-version dist; identical installed external dependencies',
        execution:
          'One process; both versions imported before warmup; sequential alternating AB/BA measurement order; no overlapping benchmark workloads',
        latency:
          'Elapsed per workload; multi-iteration samples report per-workload averages; failure case includes draining outstanding reads and separately records API latency',
        throughput_unit:
          'Complete map call, fee estimate, or monitor cycle per second, not individual RPC calls',
        memory:
          'Shared-process RSS after each sample, not per-version allocation or isolated workload peak',
        cpu: 'Process CPU user+system deltas; includes harness counters/output validation and any GC during the sample',
        gc: 'No forced GC; same process and alternating version order',
        provider_count:
          'Controlled provider-stub invocations, not production wire RPC counts; getFeeData is modeled as one read',
        warmups,
        repetitions,
      },
      sources: Object.fromEntries(
        Object.entries(sources).map(([version, source]) => [
          version,
          { commit: source.commit, files: source.files },
        ]),
      ),
      workloads: [],
    };
    for (const scenario of scenarios) {
      process.stderr.write(`Measuring ${scenario.id}\n`);
      const prepared = Object.fromEntries(
        Object.entries(versions).map(([version, source]) => [
          version,
          source.prepare(scenario),
        ]),
      );
      const samples = [];
      for (let round = -warmups; round < repetitions; round++) {
        const order =
          Math.abs(round) % 2 === 0
            ? ['baseline', 'proposed']
            : ['proposed', 'baseline'];
        for (const version of order) {
          const sample = await measure(
            prepared[version],
            scenario,
            round,
            version,
          );
          if (round >= 0) samples.push(sample);
        }
      }
      const summaries = Object.fromEntries(
        ['baseline', 'proposed'].map((version) => [
          version,
          summarize(samples.filter((sample) => sample.version === version)),
        ]),
      );
      result.workloads.push({
        ...scenario,
        summaries,
        p50_speedup: summaries.baseline.p50_ms / summaries.proposed.p50_ms,
        samples,
      });
      writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
    }
    result.process_peak_rss_kib = process.resourceUsage().maxRSS;
    writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
    writeFileSync(output.replace(/\.json$/, '') + '.md', markdown(result));
    console.table(
      result.workloads.map((workload) => ({
        workload: workload.id,
        baseline_p50_ms: workload.summaries.baseline.p50_ms.toFixed(3),
        proposed_p50_ms: workload.summaries.proposed.p50_ms.toFixed(3),
        speedup: `${workload.p50_speedup.toFixed(2)}x`,
        baseline_p95_ms: workload.summaries.baseline.p95_ms.toFixed(3),
        proposed_p95_ms: workload.summaries.proposed.p95_ms.toFixed(3),
        baseline_cpu_ms: workload.summaries.baseline.p50_cpu_ms.toFixed(3),
        proposed_cpu_ms: workload.summaries.proposed.p50_cpu_ms.toFixed(3),
        provider_calls_per_operation: `${workload.summaries.baseline.provider_calls_per_operation}/${workload.summaries.proposed.provider_calls_per_operation}`,
        peak_inflight: `${workload.summaries.baseline.peak_inflight}/${workload.summaries.proposed.peak_inflight}`,
      })),
    );
    process.stderr.write(`Raw measurements: ${output}\n`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
