import { spawn, spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import chalk from 'chalk';

import { assert } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { getArgs, withChains, withContext } from '../agent-utils.js';

const METRICS_PORT = 9090;
const PORT_FORWARD_READY_REGEX = /Forwarding from/;

type ChainConfig = {
  index?: {
    from?: number;
  };
};

type RustConfig = {
  chains: Record<string, ChainConfig>;
};

type SyncProgressArgs = {
  environment: string;
  context: Contexts;
  chains?: string[];
  namespace?: string;
  localPortStart: number;
  ready?: boolean;
};

type MetricSample = {
  labels: Record<string, string>;
  value: number;
};

type Metrics = Record<string, MetricSample[]>;

type ProgressRow = {
  chain: string;
  pod: string;
  indexFromBlock: number;
  headBlock?: number;
  forwardBlock?: number;
  forwardProgress?: number;
  backwardBlock?: number;
  backfillProgress?: number;
  maxSequence?: number;
  forwardSequence?: number;
  backwardSequence?: number;
  observedCheckpoint?: number;
  processedCheckpoint?: number;
  announced?: boolean;
  backfillComplete?: boolean;
  reachedInitialConsistency?: boolean;
  criticalError?: boolean;
  ready: boolean;
  error?: string;
};

function rustConfigPath(environment: string): string {
  const repoRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../..',
  );
  switch (environment) {
    case 'mainnet3':
      return resolve(repoRoot, 'rust/main/config/mainnet_config.json');
    case 'testnet4':
      return resolve(repoRoot, 'rust/main/config/testnet_config.json');
    default:
      throw new Error(`Unsupported environment ${environment}`);
  }
}

function loadRustConfig(environment: string): RustConfig {
  return JSON.parse(readFileSync(rustConfigPath(environment), 'utf-8'));
}

function runKubectl(args: readonly string[]): string {
  const result = spawnSync('kubectl', args, {
    encoding: 'utf-8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(result.stderr || result.error?.message || result.stdout);
  }
  return result.stdout;
}

function parsePodNames(text: string): string[] {
  return text.split('\n').filter(Boolean);
}

function isContext(value: unknown): value is Contexts {
  return (
    typeof value === 'string' &&
    Object.values(Contexts).some((context) => context === value)
  );
}

function parseArgs(argv: {
  environment?: unknown;
  context?: unknown;
  chains?: unknown;
  namespace?: unknown;
  localPortStart?: unknown;
  ready?: unknown;
}): SyncProgressArgs {
  const { environment, context, chains, namespace, localPortStart, ready } =
    argv;
  assert(typeof environment === 'string', 'environment must be a string');
  assert(isContext(context), 'context must be a valid context');
  assert(
    chains === undefined ||
      (Array.isArray(chains) &&
        chains.every((chain) => typeof chain === 'string')),
    'chains must be an array of strings',
  );
  assert(
    namespace === undefined || typeof namespace === 'string',
    'namespace must be a string',
  );
  assert(
    typeof localPortStart === 'number',
    'local-port-start must be a number',
  );
  assert(
    ready === undefined || typeof ready === 'boolean',
    'ready must be a boolean',
  );

  return { environment, context, chains, namespace, localPortStart, ready };
}

function parseLabels(rawLabels: string | undefined): Record<string, string> {
  if (!rawLabels) return {};

  const labels: Record<string, string> = {};
  const labelRegex = /([^=,\s]+)="([^"]*)"/g;
  for (const match of rawLabels.matchAll(labelRegex)) {
    labels[match[1]] = match[2];
  }
  return labels;
}

function parseMetrics(text: string): Metrics {
  const metrics: Metrics = {};
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;

    const match = line.match(
      /^([^{\s]+)(?:\{([^}]*)\})?\s+(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i,
    );
    if (!match) continue;

    const [, name, rawLabels, rawValue] = match;
    metrics[name] ??= [];
    metrics[name].push({
      labels: parseLabels(rawLabels),
      value: Number(rawValue),
    });
  }
  return metrics;
}

function sample(
  metrics: Metrics,
  name: string,
  labels: Record<string, string> = {},
): number | undefined {
  return metrics[name]?.find((metric) =>
    Object.entries(labels).every(
      ([key, value]) => metric.labels[key] === value,
    ),
  )?.value;
}

function backfillPercentage(
  current: number,
  fromBlock: number,
  targetBlock: number,
): number {
  if (fromBlock <= targetBlock) return 100;
  return Math.max(
    0,
    Math.min(100, ((fromBlock - current) / (fromBlock - targetBlock)) * 100),
  );
}

function sequenceProgress(
  current: number | undefined,
  target: number | undefined,
): number | undefined {
  if (current === undefined || target === undefined) return undefined;
  if (target <= 0) return 100;
  return Math.max(0, Math.min(100, (current / target) * 100));
}

function formatPercent(value: number | undefined): string {
  return value === undefined ? '-' : `${value.toFixed(2)}%`;
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? '-' : value.toString();
}

function formatBool(value: boolean | undefined): string {
  if (value === undefined) return '-';
  return value ? 'yes' : 'no';
}

async function waitForPortForward(
  pod: string,
  namespace: string,
  localPort: number,
): Promise<ReturnType<typeof spawn>> {
  const child = spawn('kubectl', [
    'port-forward',
    '-n',
    namespace,
    `pod/${pod}`,
    `${localPort}:${METRICS_PORT}`,
  ]);

  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out waiting for port-forward to ${pod}`));
    }, 10_000);

    const onData = (data: Buffer) => {
      const output = data.toString();
      if (PORT_FORWARD_READY_REGEX.test(output)) {
        clearTimeout(timeout);
        resolvePromise(child);
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`port-forward to ${pod} exited with code ${code}`));
    });
  });
}

async function fetchPodMetrics(
  pod: string,
  namespace: string,
  localPort: number,
): Promise<Metrics> {
  const portForward = await waitForPortForward(pod, namespace, localPort);
  try {
    const response = await fetch(`http://127.0.0.1:${localPort}/metrics`);
    assert(
      response.ok,
      `Failed to fetch metrics from ${pod}: ${response.status}`,
    );
    return parseMetrics(await response.text());
  } finally {
    portForward.kill();
  }
}

function chainFromPod(podName: string, chains: string[]): string | undefined {
  return chains
    .sort((a, b) => b.length - a.length)
    .find((chain) => podName.startsWith(`${chain}-validator-`));
}

function buildRow(
  chain: string,
  pod: string,
  metrics: Metrics,
  config: RustConfig,
): ProgressRow {
  const indexFromBlock = config.chains[chain]?.index?.from ?? 1;
  const headBlock = sample(metrics, 'hyperlane_block_height', { chain });
  const forwardBlock = sample(metrics, 'hyperlane_cursor_current_block', {
    chain,
    cursor_type: 'forward_sequenced',
    event_type: 'merkle_tree_insertion',
  });
  const backwardBlock = sample(metrics, 'hyperlane_cursor_current_block', {
    chain,
    cursor_type: 'backward_sequenced',
    event_type: 'merkle_tree_insertion',
  });
  const maxSequence = sample(metrics, 'hyperlane_cursor_max_sequence', {
    chain,
    event_type: 'merkle_tree_insertion',
  });
  const forwardSequence = sample(metrics, 'hyperlane_cursor_current_sequence', {
    chain,
    cursor_type: 'forward_sequenced',
    event_type: 'merkle_tree_insertion',
  });
  const backwardSequence = sample(
    metrics,
    'hyperlane_cursor_current_sequence',
    {
      chain,
      cursor_type: 'backward_sequenced',
      event_type: 'merkle_tree_insertion',
    },
  );
  const observedCheckpoint = sample(metrics, 'hyperlane_latest_checkpoint', {
    chain,
    phase: 'validator_observed',
  });
  const processedCheckpoint = sample(metrics, 'hyperlane_latest_checkpoint', {
    chain,
    phase: 'validator_processed',
  });
  const announced = sample(metrics, 'hyperlane_announced', { chain }) === 1;
  const backfillComplete =
    sample(metrics, 'hyperlane_backfill_complete', { chain }) === 1;
  const reachedInitialConsistency =
    sample(metrics, 'hyperlane_reached_initial_consistency', { chain }) === 1;
  const criticalError =
    sample(metrics, 'hyperlane_critical_error', { chain }) === 1;

  const ready =
    announced &&
    backfillComplete &&
    reachedInitialConsistency &&
    !criticalError &&
    observedCheckpoint !== undefined &&
    processedCheckpoint !== undefined &&
    processedCheckpoint >= observedCheckpoint;

  return {
    chain,
    pod,
    indexFromBlock,
    headBlock,
    forwardBlock,
    forwardProgress:
      headBlock !== undefined && forwardBlock !== undefined
        ? backfillPercentage(headBlock, headBlock, indexFromBlock)
        : undefined,
    backwardBlock,
    backfillProgress:
      headBlock !== undefined && backwardBlock !== undefined
        ? backfillPercentage(backwardBlock, headBlock, indexFromBlock)
        : sequenceProgress(backwardSequence, maxSequence),
    maxSequence,
    forwardSequence,
    backwardSequence,
    observedCheckpoint,
    processedCheckpoint,
    announced,
    backfillComplete,
    reachedInitialConsistency,
    criticalError,
    ready,
  };
}

function printRows(rows: ProgressRow[]) {
  console.table(
    rows.map((row) => ({
      chain: row.chain,
      backfillFrom: formatNumber(row.headBlock),
      backfillBlock: formatNumber(row.backwardBlock),
      backfillTarget: formatNumber(row.indexFromBlock),
      backfill: formatPercent(row.backfillProgress),
      backfillSeq: `${formatNumber(row.backwardSequence)}/${formatNumber(row.maxSequence)}`,
      observed: formatNumber(row.observedCheckpoint),
      processed: formatNumber(row.processedCheckpoint),
      backfillDone: formatBool(row.backfillComplete),
      critical: formatBool(row.criticalError),
      ready: row.ready ? 'yes' : 'no',
      error: row.error ?? '',
    })),
  );
}

async function main() {
  const rawArgv = await withChains(withContext(getArgs()))
    .describe('namespace', 'Kubernetes namespace')
    .string('namespace')
    .describe(
      'local-port-start',
      'First local port used for metrics port-forwarding',
    )
    .number('local-port-start')
    .default('local-port-start', 19090)
    .describe('ready', 'Filter by ready status; use --ready or --ready=false')
    .boolean('ready').argv;
  const argv = parseArgs(rawArgv);

  const {
    environment,
    context,
    chains,
    namespace: namespaceArg,
    localPortStart,
    ready: readyFilter,
  } = argv;
  const namespace = namespaceArg ?? `validator-${environment}`;
  const config = loadRustConfig(environment);
  const configuredChains = Object.keys(config.chains);
  const chainFilter = new Set(chains ?? configuredChains);

  const podNames = parsePodNames(
    runKubectl([
      'get',
      'pods',
      '-n',
      namespace,
      '--selector',
      `hyperlane/context=${context},app.kubernetes.io/component=validator`,
      '-o',
      'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
    ]),
  );
  const validatorPods = podNames
    .map((name) => ({ name, chain: chainFromPod(name, configuredChains) }))
    .filter(
      (pod): pod is { name: string; chain: string } =>
        !!pod.chain && chainFilter.has(pod.chain),
    )
    .sort((a, b) => a.chain.localeCompare(b.chain));

  if (validatorPods.length === 0) {
    console.log(
      chalk.yellow(`No validator pods found in namespace ${namespace}`),
    );
    return;
  }

  const rows: ProgressRow[] = [];
  for (const [idx, pod] of validatorPods.entries()) {
    try {
      const metrics = await fetchPodMetrics(
        pod.name,
        namespace,
        localPortStart + idx,
      );
      const row = buildRow(pod.chain, pod.name, metrics, config);
      if (readyFilter === undefined || row.ready === readyFilter) {
        rows.push(row);
      }
    } catch (error) {
      console.warn(
        chalk.yellow(`[${pod.chain}] Failed to read metrics: ${error}`),
      );
      if (readyFilter === false) {
        rows.push({
          chain: pod.chain,
          pod: pod.name,
          indexFromBlock: config.chains[pod.chain]?.index?.from ?? 1,
          ready: false,
          error: String(error),
        });
      }
    }
  }

  printRows(rows);
}

main().catch((err) => {
  console.error('Error checking validator sync progress:', err);
  process.exit(1);
});
