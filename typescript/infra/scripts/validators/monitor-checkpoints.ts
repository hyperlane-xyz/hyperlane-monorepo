/**
 * Validator checkpoint liveness monitor.
 *
 * Polls each whitelisted validator's latest signed checkpoint index directly
 * from its checkpoint syncer (S3/GCS) and reports it alongside two reference
 * points for lag:
 *   - the on-chain MerkleTreeHook leaf count (absolute head), and
 *   - the furthest-ahead peer in the same validator set on the same chain.
 *
 * The job is deliberately dumb: it reports the latest read and the derived lags
 * as plain gauges and does no thresholding of its own. All tolerance lives in
 * the alert, which should only fire when a validator has been many messages
 * behind the on-chain head while its peers keep progressing, sustained over
 * hours. That keeps a healthy validator momentarily a leaf or two behind (or
 * even briefly ahead of our once-per-run on-chain snapshot) from ever flapping.
 *
 * Usage (all sets, push to prometheus):
 *   pnpm tsx scripts/validators/monitor-checkpoints.ts -e mainnet3 --pushMetrics
 *
 * Usage (local inspection, one set, no push):
 *   pnpm tsx scripts/validators/monitor-checkpoints.ts -e mainnet3 --set renzo
 */
import chalk from 'chalk';
import { Gauge, Registry } from 'prom-client';

import {
  MerkleTreeHook__factory,
  ValidatorAnnounce__factory,
} from '@hyperlane-xyz/core';
import { submitMetrics } from '@hyperlane-xyz/metrics';
import {
  MultiProvider,
  getValidatorFromStorageLocation,
} from '@hyperlane-xyz/sdk';
import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { getChainAddresses } from '../../config/registry.js';
import { isEthereumProtocolChain } from '../../src/utils/utils.js';
import {
  MonitoredValidator,
  ValidatorSetName,
  getMonitoredValidatorSets,
} from '../../src/validators/monitorConfig.js';
import {
  getArgs as getRootArgs,
  withChains,
  withPushMetrics,
} from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

function getArgs() {
  return withChains(withPushMetrics(getRootArgs()))
    .describe('set', 'only monitor a single validator set')
    .choices('set', Object.values(ValidatorSetName)).argv;
}

type ValidatorReading = {
  set: ValidatorSetName;
  chain: string;
  address: string;
  alias: string;
  // Whether the announced syncer could be resolved and read.
  reachable: boolean;
  // Latest checkpoint index read from the syncer, or -1 if unreachable or the
  // validator has not signed any checkpoint yet.
  index: number;
};

type ValidatorRow = ValidatorReading & {
  onchainCount: number | undefined;
  lagOnchain: number | undefined;
  lagPeer: number | undefined;
};

// Resolve a validator's announced storage location and read the latest
// checkpoint index it advertises. This is intentionally the raw latest read: no
// signature/domain/hook verification and no rejection of indices ahead of our
// on-chain snapshot. A stalled validator simply stops advancing this index, so
// its lag grows monotonically and the alert catches it.
async function readLatestCheckpointIndex(
  chain: string,
  address: string,
  multiProvider: MultiProvider,
  validatorAnnounceAddress: string,
): Promise<{ reachable: boolean; index: number }> {
  try {
    const validatorAnnounce = ValidatorAnnounce__factory.connect(
      validatorAnnounceAddress,
      multiProvider.getProvider(chain),
    );
    const [locations] = await validatorAnnounce.getAnnouncedStorageLocations([
      address,
    ]);
    const location = locations?.[locations.length - 1];
    if (!location) {
      return { reachable: false, index: -1 };
    }

    const validator = await getValidatorFromStorageLocation(location);
    const index = await validator.getLatestCheckpointIndex();
    return { reachable: true, index };
  } catch (error) {
    rootLogger.debug(`[${chain}] ${address} unreachable: ${error}`);
    return { reachable: false, index: -1 };
  }
}

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);
  const {
    environment,
    pushMetrics,
    chains: chainFilter,
    set: setFilter,
  } = await getArgs();

  const sets = getMonitoredValidatorSets(environment).filter(
    (s) => !setFilter || s.name === setFilter,
  );

  const envConfig = getEnvironmentConfig(environment);

  // Union of chains across the selected sets, restricted to EVM chains this
  // environment supports (so we have RPC/secrets and a MerkleTreeHook to read),
  // and to the optional --chains filter.
  const targetChains = Array.from(
    new Set(sets.flatMap((s) => Object.keys(s.validators))),
  )
    .filter((c) => envConfig.supportedChainNames.includes(c))
    .filter(isEthereumProtocolChain)
    .filter((c) => !chainFilter?.length || chainFilter.includes(c));

  if (targetChains.length === 0) {
    rootLogger.error('No target chains after filtering');
    process.exit(1);
  }

  // Read-only workload: build an unsigned MultiProvider straight from the
  // secret-backed registry RPC metadata. We never sign anything here, so we do
  // NOT ask for Role.Deployer (which would eagerly install the mainnet deployer
  // key on every EVM provider — unnecessary privileged-key exposure).
  const registry = await envConfig.getRegistry(true, targetChains);
  const multiProvider = new MultiProvider(await registry.getMetadata(), {
    minConfirmationTimeoutMs: 300_000,
  });
  const chainAddresses = getChainAddresses();

  // On-chain merkle leaf count per chain (absolute head). undefined if the read
  // fails, in which case we still report reachability but omit the on-chain lag
  // so a chain-wide RPC hiccup can't masquerade as "caught up".
  const onchainCounts: Record<string, number | undefined> = {};
  await Promise.all(
    targetChains.map(async (chain) => {
      try {
        const merkleTreeHook = MerkleTreeHook__factory.connect(
          chainAddresses[chain].merkleTreeHook,
          multiProvider.getProvider(chain),
        );
        onchainCounts[chain] = await merkleTreeHook.count();
      } catch (error) {
        rootLogger.error(
          `[${chain}] Failed to read on-chain merkle count: ${error}`,
        );
        onchainCounts[chain] = undefined;
      }
    }),
  );

  // Resolve and read each validator's latest checkpoint index once per
  // (chain, address); a validator may appear in more than one set.
  const readingCache = new Map<
    string,
    Promise<{ reachable: boolean; index: number }>
  >();
  const readIndex = (chain: string, address: string) => {
    const key = `${chain}:${address.toLowerCase()}`;
    let cached = readingCache.get(key);
    if (!cached) {
      cached = readLatestCheckpointIndex(
        chain,
        address,
        multiProvider,
        chainAddresses[chain].validatorAnnounce,
      );
      readingCache.set(key, cached);
    }
    return cached;
  };

  const readings: ValidatorReading[] = [];
  await Promise.all(
    sets.flatMap((s) =>
      targetChains
        .filter((chain) => s.validators[chain]?.length)
        .flatMap((chain) =>
          s.validators[chain].map(async (validator: MonitoredValidator) => {
            const { reachable, index } = await readIndex(
              chain,
              validator.address,
            );
            readings.push({
              set: s.name,
              chain,
              address: validator.address,
              alias: validator.alias,
              reachable,
              index,
            });
          }),
        ),
    ),
  );

  // Furthest-ahead reachable peer per (set, chain) for the relative diff.
  const peerMax = new Map<string, number>();
  for (const r of readings) {
    if (!r.reachable || r.index < 0) continue;
    const key = `${r.set}:${r.chain}`;
    peerMax.set(key, Math.max(peerMax.get(key) ?? -1, r.index));
  }

  const rows: ValidatorRow[] = readings.map((r) => {
    const onchainCount = onchainCounts[r.chain];
    const hasIndex = r.reachable && r.index >= 0;
    // On-chain latest leaf index is count - 1. Clamp at 0 so a validator briefly
    // ahead of our once-per-run snapshot reports 0 lag rather than a negative.
    const lagOnchain =
      hasIndex && onchainCount !== undefined
        ? Math.max(0, onchainCount - 1 - r.index)
        : undefined;
    const peer = peerMax.get(`${r.set}:${r.chain}`);
    const lagPeer =
      hasIndex && peer !== undefined ? Math.max(0, peer - r.index) : undefined;
    return { ...r, onchainCount, lagOnchain, lagPeer };
  });

  printReport(rows);

  if (pushMetrics) {
    await pushValidatorMetrics(rows, onchainCounts, environment);
  }

  process.exit(0);
}

function printReport(rows: ValidatorRow[]) {
  const bySet = new Map<ValidatorSetName, ValidatorRow[]>();
  for (const row of rows) {
    const existing = bySet.get(row.set) ?? [];
    existing.push(row);
    bySet.set(row.set, existing);
  }

  for (const [set, setRows] of bySet) {
    rootLogger.info(`\n${set} validators:`);
    const table = setRows
      .slice()
      .sort(
        (a, b) =>
          a.chain.localeCompare(b.chain) ||
          (b.lagPeer ?? -1) - (a.lagPeer ?? -1),
      )
      .map((r) => ({
        chain: r.chain,
        alias: r.alias,
        index: r.index,
        onchain: r.onchainCount ?? '?',
        lag_onchain: r.lagOnchain ?? '?',
        lag_peer: r.lagPeer ?? '?',
        reachable: r.reachable ? '✅' : '❌',
      }));
    // eslint-disable-next-line no-console
    console.table(table);
  }

  const unreachable = rows.filter((r) => !r.reachable);
  if (unreachable.length > 0) {
    rootLogger.warn(
      chalk.yellow(`\n${unreachable.length} validator(s) unreachable:`),
    );
    for (const r of unreachable) {
      rootLogger.warn(
        chalk.yellow(`  - [${r.chain}] ${r.set}/${r.alias} ${r.address}`),
      );
    }
  }
}

// The whole job group is overwritten (PUT) on every run so the published metrics
// are a full snapshot: a validator removed from config, or a set no longer
// monitored, disappears cleanly instead of lingering as a ghost series. Every
// monitored validator is always represented (reachable 0/1), so a validator we
// failed to read shows as unreachable rather than vanishing.
async function pushValidatorMetrics(
  rows: ValidatorRow[],
  onchainCounts: Record<string, number | undefined>,
  environment: string,
) {
  const register = new Registry();
  const labelNames = ['chain', 'validator', 'alias', 'validator_set'];

  const reachableGauge = new Gauge({
    name: 'hyperlane_validator_reachable',
    help: 'Whether the validator syncer could be resolved and read (1) or not (0)',
    registers: [register],
    labelNames,
  });
  const indexGauge = new Gauge({
    name: 'hyperlane_validator_checkpoint_index',
    help: 'Latest checkpoint index signed by the validator (from its syncer)',
    registers: [register],
    labelNames,
  });
  const lagOnchainGauge = new Gauge({
    name: 'hyperlane_validator_checkpoint_lag_onchain',
    help: 'Leaves behind the on-chain merkle tree count (absolute lag)',
    registers: [register],
    labelNames,
  });
  const lagPeerGauge = new Gauge({
    name: 'hyperlane_validator_checkpoint_lag_peer',
    help: 'Leaves behind the furthest-ahead peer in the same set on the same chain',
    registers: [register],
    labelNames,
  });
  const onchainCountGauge = new Gauge({
    name: 'hyperlane_validator_onchain_merkle_count',
    help: 'On-chain MerkleTreeHook leaf count',
    registers: [register],
    labelNames: ['chain'],
  });
  // Explicit per-chain success signal for the on-chain read. Because the group
  // is PUT-overwritten each run, a chain whose merkle-count read failed drops
  // its lag_onchain series entirely — which would silently clear a lag alert.
  // This gauge lets alerts fail CLOSED: treat lag_onchain as unknown (not
  // caught up) whenever onchain_read_success == 0 for a chain.
  const onchainReadSuccessGauge = new Gauge({
    name: 'hyperlane_validator_monitor_onchain_read_success',
    help: 'Whether the on-chain MerkleTreeHook count read succeeded (1) or not (0)',
    registers: [register],
    labelNames: ['chain'],
  });

  for (const [chain, count] of Object.entries(onchainCounts)) {
    onchainReadSuccessGauge.labels({ chain }).set(count !== undefined ? 1 : 0);
    if (count !== undefined) {
      onchainCountGauge.labels({ chain }).set(count);
    }
  }

  for (const row of rows) {
    const labels = {
      chain: row.chain,
      validator: row.address,
      alias: row.alias,
      validator_set: row.set,
    };
    reachableGauge.labels(labels).set(row.reachable ? 1 : 0);
    if (row.reachable && row.index >= 0) {
      indexGauge.labels(labels).set(row.index);
    }
    if (row.lagOnchain !== undefined) {
      lagOnchainGauge.labels(labels).set(row.lagOnchain);
    }
    if (row.lagPeer !== undefined) {
      lagPeerGauge.labels(labels).set(row.lagPeer);
    }
  }

  // Propagate push failure: if the PushGateway is unreachable, the CronJob must
  // fail so Kubernetes does not record a successful run while the previous
  // snapshot silently goes stale. Alert on snapshot freshness as a backstop.
  await submitMetrics(register, `validator-monitor-${environment}`, {
    overwriteAllMetrics: true,
    throwOnError: true,
  });
}

main().catch((err) => {
  rootLogger.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
