/**
 * Validator checkpoint liveness monitor.
 *
 * Polls each whitelisted validator's latest signed checkpoint directly from its
 * checkpoint syncer (S3/GCS) and compares it against ground truth:
 *   - the on-chain MerkleTreeHook leaf count (absolute lag), and
 *   - the furthest-ahead peer in the same validator set on the same chain
 *     (relative/peer lag).
 *
 * Unlike the relayer-observed `hyperlane_observed_validator_latest_index`
 * metric, this reads the syncer directly, so a stalled validator produces a
 * monotonically growing lag that only clears when the validator resumes
 * signing. That makes it a clean, non-flapping basis for a downtime alert.
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
import { getValidatorFromStorageLocation } from '@hyperlane-xyz/sdk';
import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { getChainAddresses } from '../../config/registry.js';
import { Role } from '../../src/roles.js';
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

// A reachable validator whose signed checkpoint trails the furthest-ahead peer
// in its set on the same chain by at least this many leaves is treated as
// stalled relative to its peers. Peer lag is volume-independent: it only grows
// when peers keep signing while this validator does not.
const PEER_LAG_STALL_THRESHOLD = 5;

// Backstop for validators with no live peer to diff against (e.g. single-signer
// chains): treat a validator trailing the on-chain merkle count by at least this
// many leaves as stalled. Set generously above normal catch-up jitter (observed
// 0-2 leaves) so a healthy validator briefly behind during a dispatch burst is
// never flagged.
const ONCHAIN_LAG_STALL_THRESHOLD = 50;

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
  // Latest checkpoint index signed by the validator (-1 if none / unreachable).
  index: number;
  reachable: boolean;
};

type ValidatorRow = ValidatorReading & {
  onchainCount: number | undefined;
  lagOnchain: number | undefined;
  lagPeer: number | undefined;
  down: boolean;
};

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

  const multiProvider = await envConfig.getMultiProvider(
    Contexts.Hyperlane,
    Role.Deployer,
    true,
    targetChains,
  );
  const chainAddresses = getChainAddresses();

  // On-chain merkle leaf count per chain (absolute ground truth). undefined if
  // the read fails, in which case we still report reachability but omit the
  // on-chain lag so a chain-wide RPC hiccup can't masquerade as "resolved".
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

  // Resolve + read each validator's latest checkpoint index once per
  // (chain, address); a validator may appear in more than one set.
  const readingCache = new Map<string, Promise<number>>();
  const readIndex = (chain: string, address: string): Promise<number> => {
    const key = `${chain}:${address.toLowerCase()}`;
    let cached = readingCache.get(key);
    if (!cached) {
      cached = (async () => {
        const validatorAnnounce = ValidatorAnnounce__factory.connect(
          chainAddresses[chain].validatorAnnounce,
          multiProvider.getProvider(chain),
        );
        const [locations] =
          await validatorAnnounce.getAnnouncedStorageLocations([address]);
        const location = locations?.[locations.length - 1];
        if (!location) {
          throw new Error('no announced storage location');
        }
        const validator = await getValidatorFromStorageLocation(location);
        return validator.getLatestCheckpointIndex();
      })();
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
            try {
              const index = await readIndex(chain, validator.address);
              readings.push({
                set: s.name,
                chain,
                address: validator.address,
                alias: validator.alias,
                index,
                reachable: index >= 0,
              });
            } catch (error) {
              rootLogger.debug(
                `[${chain}] ${s.name}/${validator.alias} (${validator.address}) unreachable: ${error}`,
              );
              readings.push({
                set: s.name,
                chain,
                address: validator.address,
                alias: validator.alias,
                index: -1,
                reachable: false,
              });
            }
          }),
        ),
    ),
  );

  // Furthest-ahead reachable peer per (set, chain) for the relative diff.
  const peerMax = new Map<string, number>();
  for (const r of readings) {
    if (!r.reachable) continue;
    const key = `${r.set}:${r.chain}`;
    peerMax.set(key, Math.max(peerMax.get(key) ?? -1, r.index));
  }

  const rows: ValidatorRow[] = readings.map((r) => {
    const onchainCount = onchainCounts[r.chain];
    // On-chain latest leaf index is count - 1.
    const lagOnchain =
      r.reachable && onchainCount !== undefined
        ? Math.max(0, onchainCount - 1 - r.index)
        : undefined;
    const peer = peerMax.get(`${r.set}:${r.chain}`);
    const lagPeer =
      r.reachable && peer !== undefined
        ? Math.max(0, peer - r.index)
        : undefined;
    const down =
      !r.reachable ||
      (lagPeer !== undefined && lagPeer >= PEER_LAG_STALL_THRESHOLD) ||
      (lagOnchain !== undefined && lagOnchain >= ONCHAIN_LAG_STALL_THRESHOLD);
    return { ...r, onchainCount, lagOnchain, lagPeer, down };
  });

  printReport(rows);

  if (pushMetrics) {
    await pushValidatorMetrics(rows, environment);
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
        status: r.down ? '❌ DOWN' : '✅',
      }));
    // eslint-disable-next-line no-console
    console.table(table);
  }

  const down = rows.filter((r) => r.down);
  if (down.length === 0) {
    rootLogger.info(chalk.green('\nAll monitored validators are live.'));
  } else {
    rootLogger.warn(
      chalk.yellow(`\n${down.length} validator(s) flagged as down:`),
    );
    for (const r of down) {
      const reason = !r.reachable
        ? 'unreachable / no checkpoints'
        : r.lagPeer !== undefined && r.lagPeer >= PEER_LAG_STALL_THRESHOLD
          ? `peer lag ${r.lagPeer} (onchain lag ${r.lagOnchain})`
          : `onchain lag ${r.lagOnchain} (no live peer)`;
      rootLogger.warn(
        chalk.yellow(
          `  - [${r.chain}] ${r.set}/${r.alias} ${r.address}: ${reason}`,
        ),
      );
    }
  }
}

// The whole job group is overwritten (PUT) on every run so the published metrics
// are a full snapshot: a validator removed from config, or a set no longer
// monitored, disappears cleanly instead of lingering as a ghost series. Every
// monitored validator is always represented (reachable 0/1), so a validator we
// failed to read shows as unreachable rather than vanishing.
async function pushValidatorMetrics(rows: ValidatorRow[], environment: string) {
  const register = new Registry();
  const labelNames = ['chain', 'validator', 'alias', 'validator_set'];

  const reachableGauge = new Gauge({
    name: 'hyperlane_validator_reachable',
    help: 'Whether the validator checkpoint syncer could be read (1) or not (0)',
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

  const seenChains = new Set<string>();
  for (const row of rows) {
    const labels = {
      chain: row.chain,
      validator: row.address,
      alias: row.alias,
      validator_set: row.set,
    };
    reachableGauge.labels(labels).set(row.reachable ? 1 : 0);
    if (row.reachable) {
      indexGauge.labels(labels).set(row.index);
    }
    if (row.lagOnchain !== undefined) {
      lagOnchainGauge.labels(labels).set(row.lagOnchain);
    }
    if (row.lagPeer !== undefined) {
      lagPeerGauge.labels(labels).set(row.lagPeer);
    }
    if (row.onchainCount !== undefined && !seenChains.has(row.chain)) {
      seenChains.add(row.chain);
      onchainCountGauge.labels({ chain: row.chain }).set(row.onchainCount);
    }
  }

  await submitMetrics(register, `validator-monitor-${environment}`, {
    overwriteAllMetrics: true,
  });
}

main().catch((err) => {
  rootLogger.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
