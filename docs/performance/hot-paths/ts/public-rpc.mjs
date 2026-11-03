#!/usr/bin/env node
// Optional live read-only comparison. Never invoked by the controlled benchmark.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, platform, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { snapshot } from './benchmark.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const BASELINE = '7e80c603f0278c9b1f0555fe0106279e2df5f070';
const PROPOSED = 'd555ffbfd7d82438851e6f848ea7dfc28b2e336d';
const DEFAULT_PUBLIC_EOA = '0x000000000000000000000000000000000000dEaD';
const ALLOWED_METHODS = new Set([
  'eth_estimateGas',
  'eth_getBlockByNumber',
  'eth_gasPrice',
]);
const MAX_WIRE_CALLS = 120;

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
}

function takeBudget(budget) {
  assert.ok(budget.used < MAX_WIRE_CALLS, 'hard request budget exhausted');
  budget.used++;
}

async function verifyEndpoint(endpoint, sender, budget) {
  const observations = [];
  for (const [method, params] of [
    ['eth_chainId', []],
    ['eth_getCode', [sender, 'latest']],
    ['eth_getBalance', [sender, 'latest']],
  ]) {
    takeBudget(budget);
    const start = performance.now();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: budget.used, method, params }),
      signal: AbortSignal.timeout(8000),
    });
    assert.equal(
      response.ok,
      true,
      `preflight ${method} HTTP ${response.status}`,
    );
    const body = await response.json();
    assert.equal(
      typeof body.result,
      'string',
      `preflight ${method} did not return a value`,
    );
    if (method === 'eth_chainId') assert.equal(BigInt(body.result), 1n);
    if (method === 'eth_getCode')
      assert.equal(
        body.result,
        '0x',
        'simulation sender must be an EOA without code',
      );
    if (method === 'eth_getBalance')
      assert.ok(BigInt(body.result) > 0n, 'simulation sender must be funded');
    observations.push({
      method,
      elapsed_ms: performance.now() - start,
      verified: true,
    });
  }
  return observations;
}

async function prepareVersion(ref, directory, endpoint, sender, budget) {
  const source = snapshot(ref, directory);
  const fees = await import(
    pathToFileURL(
      join(
        directory,
        'typescript/sdk/dist/providers/transactionFeeEstimators.js',
      ),
    ).href
  );
  const require = createRequire(join(directory, 'typescript/sdk/package.json'));
  const { BigNumber, providers, utils } = require('ethers');
  assert.ok(utils.isAddress(sender));
  const provider = new providers.StaticJsonRpcProvider(
    { url: endpoint, timeout: 8000, throttleLimit: 1 },
    { name: 'mainnet', chainId: 1 },
  );
  const originalSend = provider.send.bind(provider);
  const meter = {
    active: 0,
    peak: 0,
    lifetimeCalls: 0,
    requests: [],
    idleWaiters: [],
  };
  provider.send = async (method, params) => {
    assert.ok(
      !method.startsWith('eth_send'),
      'read-only benchmark rejects submission',
    );
    assert.ok(ALLOWED_METHODS.has(method), `unexpected RPC method: ${method}`);
    takeBudget(budget);
    meter.lifetimeCalls++;
    meter.peak = Math.max(meter.peak, ++meter.active);
    const start = performance.now();
    const request = { method, elapsed_ms: null, succeeded: false };
    meter.requests.push(request);
    try {
      const value = await originalSend(method, params);
      request.succeeded = true;
      if (
        method === 'eth_getBlockByNumber' &&
        value &&
        typeof value.number === 'string'
      ) {
        request.block_number = value.number;
      }
      return value;
    } catch (error) {
      request.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      request.elapsed_ms = performance.now() - start;
      meter.active--;
      if (meter.active === 0)
        for (const done of meter.idleWaiters.splice(0)) done();
    }
  };
  return {
    source,
    meter,
    async estimate() {
      assert.equal(meter.active, 0);
      meter.peak = 0;
      meter.requests = [];
      const cpuStart = process.cpuUsage();
      const start = performance.now();
      let error;
      let estimate;
      let apiElapsedMs;
      try {
        const value = await fees.estimateTransactionFeeEthersV5({
          provider,
          sender,
          transaction: { to: sender, value: BigNumber.from(0) },
        });
        estimate = Object.fromEntries(
          Object.entries(value).map(([key, amount]) => [
            key,
            amount.toString(),
          ]),
        );
        assert.ok(BigInt(estimate.gasUnits) > 0n);
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
      } finally {
        apiElapsedMs = performance.now() - start;
      }
      // Failed Promise.all calls may leave sibling reads pending. Drain them
      // before the next version, while retaining API and quiescent latency.
      if (meter.active > 0)
        await new Promise((done) => meter.idleWaiters.push(done));
      const elapsedMs = performance.now() - start;
      const cpu = process.cpuUsage(cpuStart);
      return {
        succeeded: error === undefined,
        error,
        estimate,
        api_elapsed_ms: apiElapsedMs,
        quiescent_elapsed_ms: elapsedMs,
        cpu_user_ms: cpu.user / 1000,
        cpu_system_ms: cpu.system / 1000,
        json_rpc_requests: meter.requests,
        peak_inflight: meter.peak,
        rss_bytes: process.memoryUsage().rss,
      };
    },
  };
}

function markdown(result) {
  if (!result.summaries || !result.successful_pairs) {
    return `# Public HTTP RPC comparison unavailable\n\n${result.skipped_reason ?? 'No successfully measured pairs; no performance comparison claimed.'}\n`;
  }
  const baseline = result.summaries.baseline;
  const proposed = result.summaries.proposed;
  const methodCounts = Object.fromEntries(
    ['baseline', 'proposed'].map((version) => [
      version,
      result.samples
        .filter((sample) => sample.version === version)
        .flatMap((sample) => sample.json_rpc_requests)
        .reduce((counts, request) => {
          counts[request.method] = (counts[request.method] ?? 0) + 1;
          return counts;
        }, {}),
    ]),
  );
  const methods = [
    ...new Set(
      Object.keys(methodCounts.baseline).concat(
        Object.keys(methodCounts.proposed),
      ),
    ),
  ];
  const methodSummary = methods
    .map(
      (method) =>
        `${method}: ${methodCounts.baseline[method] ?? 0}/${methodCounts.proposed[method] ?? 0}`,
    )
    .join('; ');
  return [
    '# Actual public HTTP RPC fee-estimator results',
    '',
    `Endpoint: ${result.endpoint}. Node ${result.environment.node}, ${result.environment.cpu_model}.`,
    '',
    `Baseline ${result.sources.baseline.commit}; proposed ${result.sources.proposed.commit}. The three compared TypeScript file blobs equal workspace head ${result.source_equivalence.workspace_head}.`,
    '',
    `${result.method.warmups} warmups and ${result.method.pairs} alternating AB/BA pairs. ${result.successful_pairs}/${result.method.pairs} pairs succeeded. Median paired speedup: ${result.median_paired_speedup.toFixed(2)}x.`,
    '',
    '| Metric | Baseline | Proposed |',
    '| --- | ---: | ---: |',
    `| Successful estimates | ${baseline.successful}/${baseline.attempted} | ${proposed.successful}/${proposed.attempted} |`,
    `| API p50, ms | ${baseline.p50_ms.toFixed(3)} | ${proposed.p50_ms.toFixed(3)} |`,
    `| API p95, ms | ${baseline.p95_ms.toFixed(3)} | ${proposed.p95_ms.toFixed(3)} |`,
    `| Estimates/s, measured active time | ${baseline.workloads_per_second.toFixed(2)} | ${proposed.workloads_per_second.toFixed(2)} |`,
    `| p50 CPU, ms/estimate | ${baseline.p50_cpu_ms.toFixed(3)} | ${proposed.p50_cpu_ms.toFixed(3)} |`,
    `| Measured JSON-RPC invocations | ${baseline.json_rpc_requests_measured} | ${proposed.json_rpc_requests_measured} |`,
    `| Measured JSON-RPC failures | ${baseline.json_rpc_failures_measured} | ${proposed.json_rpc_failures_measured} |`,
    `| Peak active JSON-RPC reads | ${baseline.peak_inflight} | ${proposed.peak_inflight} |`,
    '',
    `Total JSON-RPC invocations including warmup and preflight: ${result.total_json_rpc_invocations}/${result.method.json_rpc_hard_budget} budget. Measured method counts, baseline/proposed: ${methodSummary}.`,
    '',
    `The median ${proposed.p50_ms < baseline.p50_ms ? 'improved' : 'worsened'}, while the observed tail ${proposed.p95_ms > baseline.p95_ms ? 'worsened' : 'improved'}. With ${proposed.successful} proposed samples, nearest-rank p95 uses ordered sample ${Math.ceil(proposed.successful * 0.95)}${Math.ceil(proposed.successful * 0.95) === proposed.successful ? ' (the maximum)' : ''}: ${proposed.p95_ms.toFixed(3)} ms. No outliers were removed. Throughput excludes deliberate 250 ms inter-estimate pauses and is not a sustained public-endpoint load test.`,
    '',
    `Shared-process peak RSS: ${(result.process_peak_rss_kib / 1024).toFixed(1)} MiB, including snapshot preparation/imports. It is not an independent per-version memory measurement.`,
    '',
    'This is one public endpoint under changing network/server conditions and latest-block state; it does not establish production-wide or tail-latency gains. No signing/broadcasting occurred. Raw JSON records every request duration, observed block number, CPU/RSS sample, gas/fee result and source digest.',
    '',
  ].join('\n');
}

async function main() {
  assert.equal(process.versions.node, '26.12.1');
  const renderInput = option('--render-json', undefined);
  if (renderInput) {
    const result = JSON.parse(readFileSync(resolve(renderInput), 'utf8'));
    writeFileSync(
      resolve(renderInput).replace(/\.json$/, '') + '.md',
      markdown(result),
    );
    return;
  }
  const endpoint = option('--url', undefined);
  assert.ok(endpoint, 'Pass an explicitly verified public --url');
  const url = new URL(endpoint);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  assert.equal(
    url.search,
    '',
    'Public endpoint must not contain an API-key query',
  );
  const sender = option('--from', DEFAULT_PUBLIC_EOA);
  const repetitions = Number(option('--pairs', '15'));
  const warmups = Number(option('--warmups', '2'));
  assert.ok(
    Number.isInteger(repetitions) && repetitions > 0 && repetitions <= 15,
  );
  assert.ok(Number.isInteger(warmups) && warmups >= 0 && warmups <= 2);
  const output = resolve(
    option(
      '--output',
      join(dirname(fileURLToPath(import.meta.url)), 'public-rpc-results.json'),
    ),
  );
  const temporary = mkdtempSync(join(tmpdir(), 'hm1-ts-public-rpc-'));
  try {
    const budget = { used: 0 };
    const versions = {};
    for (const [name, ref] of Object.entries({
      baseline: BASELINE,
      proposed: PROPOSED,
    })) {
      versions[name] = await prepareVersion(
        ref,
        join(temporary, name),
        endpoint,
        sender,
        budget,
      );
    }
    if (process.argv.includes('--prepare-only')) {
      process.stderr.write(
        'Public-RPC source snapshots compiled/imported; no network requests sent.\n',
      );
      return;
    }
    const result = {
      generated_at: new Date().toISOString(),
      source_equivalence: {
        workspace_head: execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: ROOT,
          encoding: 'utf8',
        }).trim(),
        files: Object.fromEntries(
          Object.entries(versions.proposed.source.files).map(
            ([path, provenance]) => {
              const current = execFileSync(
                'git',
                ['rev-parse', `HEAD:${path}`],
                { cwd: ROOT, encoding: 'utf8' },
              ).trim();
              assert.equal(
                current,
                provenance.git_blob,
                `workspace comparison target changed: ${path}`,
              );
              return [
                path,
                {
                  proposed_git_blob: provenance.git_blob,
                  workspace_git_blob: current,
                  identical: true,
                },
              ];
            },
          ),
        ),
      },
      environment: {
        node: process.version,
        platform: platform(),
        os_release: release(),
        cpu_model: cpus()[0].model,
      },
      endpoint,
      sender,
      transaction: {
        from: sender,
        to: sender,
        value: '0x0',
        signed: false,
        broadcast: false,
      },
      method: {
        warmups,
        pairs: repetitions,
        order:
          'Sequential alternating baseline/proposed then proposed/baseline (AB/BA)',
        timeout_ms: 8000,
        throttle_limit: 1,
        json_rpc_hard_budget: MAX_WIRE_CALLS,
        expected_json_rpc_requests: (warmups + repetitions) * 2 * 3,
        counts:
          'Actual provider.send invocations over HTTP, with transport throttle retries disabled; connection failures may occur before a request reaches the server',
        limitations:
          'One public endpoint, changing network/server load and latest-block state; timings do not establish production-wide gains. Both versions share process/library/transport caches and have separate provider instances.',
      },
      sources: Object.fromEntries(
        Object.entries(versions).map(([name, version]) => [
          name,
          { commit: version.source.commit, files: version.source.files },
        ]),
      ),
      samples: [],
      warmup_samples: [],
    };
    try {
      result.verification = await verifyEndpoint(endpoint, sender, budget);
    } catch (error) {
      result.skipped_reason = `Public endpoint/fixture preflight failed: ${error instanceof Error ? error.message : String(error)}`;
      result.total_json_rpc_invocations = budget.used;
      writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = 2;
      return;
    }
    for (let pair = -warmups; pair < repetitions; pair++) {
      const order =
        Math.abs(pair) % 2 === 0
          ? ['baseline', 'proposed']
          : ['proposed', 'baseline'];
      for (const version of order) {
        const sample = {
          version,
          pair,
          ...(await versions[version].estimate()),
        };
        if (pair < 0) result.warmup_samples.push(sample);
        else result.samples.push(sample);
        process.stderr.write(
          `${pair < 0 ? 'warmup' : 'sample'} ${pair} ${version}: ${sample.succeeded ? sample.api_elapsed_ms.toFixed(1) + 'ms' : sample.error}\n`,
        );
        // Do not hammer a free public endpoint.
        await new Promise((done) => setTimeout(done, 250));
      }
      writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
      if (
        pair === -1 &&
        result.warmup_samples.every((sample) => !sample.succeeded)
      ) {
        result.total_json_rpc_invocations = budget.used;
        result.skipped_reason =
          'Both versions failed all warmups; endpoint/fixture unavailable. No timing claim made.';
        writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
        process.exitCode = 2;
        return;
      }
    }
    result.summaries = Object.fromEntries(
      ['baseline', 'proposed'].map((version) => {
        const all = result.samples.filter(
          (sample) => sample.version === version,
        );
        const successes = all.filter((sample) => sample.succeeded);
        const latency = successes.map((sample) => sample.api_elapsed_ms);
        return [
          version,
          {
            attempted: all.length,
            successful: successes.length,
            failed: all.length - successes.length,
            p50_ms: percentile(latency, 0.5),
            p95_ms: percentile(latency, 0.95),
            workloads_per_second:
              successes.length === 0
                ? null
                : (successes.length * 1000) /
                  latency.reduce((sum, value) => sum + value, 0),
            p50_cpu_ms: percentile(
              successes.map(
                (sample) => sample.cpu_user_ms + sample.cpu_system_ms,
              ),
              0.5,
            ),
            json_rpc_requests_measured: all.reduce(
              (sum, sample) => sum + sample.json_rpc_requests.length,
              0,
            ),
            json_rpc_failures_measured: all.reduce(
              (sum, sample) =>
                sum +
                sample.json_rpc_requests.filter((request) => !request.succeeded)
                  .length,
              0,
            ),
            json_rpc_requests_including_warmup:
              versions[version].meter.lifetimeCalls,
            peak_inflight: Math.max(
              ...all.map((sample) => sample.peak_inflight),
            ),
          },
        ];
      }),
    );
    const pairedRatios = [];
    for (let pair = 0; pair < repetitions; pair++) {
      const baseline = result.samples.find(
        (sample) => sample.pair === pair && sample.version === 'baseline',
      );
      const proposed = result.samples.find(
        (sample) => sample.pair === pair && sample.version === 'proposed',
      );
      if (baseline.succeeded && proposed.succeeded)
        pairedRatios.push(baseline.api_elapsed_ms / proposed.api_elapsed_ms);
    }
    result.successful_pairs = pairedRatios.length;
    result.median_paired_speedup = percentile(pairedRatios, 0.5);
    result.total_json_rpc_invocations = budget.used;
    result.process_peak_rss_kib = process.resourceUsage().maxRSS;
    writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
    writeFileSync(output.replace(/\.json$/, '') + '.md', markdown(result));
    console.table(result.summaries);
    if (result.successful_pairs === 0) process.exitCode = 2;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

await main();
