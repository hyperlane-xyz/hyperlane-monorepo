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
import {
  MultiProvider,
  getValidatorFromStorageLocation,
} from '@hyperlane-xyz/sdk';
import {
  BaseValidator,
  LogFormat,
  LogLevel,
  bytes32ToAddress,
  configureRootLogger,
  eqAddress,
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

// Outcome of resolving + reading + verifying a validator's latest checkpoint.
//   ok          - a signed checkpoint at `index` was fetched and its signature,
//                 signer, domain, hook and index all check out.
//   none        - the validator resolved but has not signed any checkpoint yet.
//   unreachable - the storage location could not be resolved or read.
//   unverified  - a latest-index pointer was read but the backing checkpoint is
//                 missing or fails verification (wrong signer, wrong domain/hook,
//                 or an index ahead of the on-chain merkle tree). Treated as not
//                 live and, crucially, excluded from peerMax so a forged pointer
//                 cannot make honest peers look stalled.
type CheckpointStatus = 'ok' | 'none' | 'unreachable' | 'unverified';

type CheckpointRead = { status: CheckpointStatus; index: number };

type ValidatorReading = {
  set: ValidatorSetName;
  chain: string;
  address: string;
  alias: string;
  status: CheckpointStatus;
  // Latest verified checkpoint index (-1 unless status is 'ok').
  index: number;
};

type ValidatorRow = ValidatorReading & {
  onchainCount: number | undefined;
  lagOnchain: number | undefined;
  lagPeer: number | undefined;
  down: boolean;
};

// Resolve a validator's announced storage location, read its latest-index
// pointer, then fetch and cryptographically verify the checkpoint it points at.
// A bare latest-index pointer is untrusted: it is unsigned, and the announced
// bucket identity is not authenticated on-chain, so a validator could announce
// a healthy peer's bucket or publish an arbitrary future index. We therefore
// only accept an index once the signed checkpoint at that index recovers to the
// expected signer for this chain's mailbox domain and merkle tree hook.
async function readAndVerifyCheckpoint(
  chain: string,
  address: string,
  multiProvider: MultiProvider,
  addresses: Record<string, string>,
  onchainCount: number | undefined,
): Promise<CheckpointRead> {
  try {
    const validatorAnnounce = ValidatorAnnounce__factory.connect(
      addresses.validatorAnnounce,
      multiProvider.getProvider(chain),
    );
    const [locations] = await validatorAnnounce.getAnnouncedStorageLocations([
      address,
    ]);
    const location = locations?.[locations.length - 1];
    if (!location) {
      return { status: 'unreachable', index: -1 };
    }

    const validator = await getValidatorFromStorageLocation(location);
    const latestIndex = await validator.getLatestCheckpointIndex();
    if (latestIndex < 0) {
      return { status: 'none', index: -1 };
    }

    // No honest checkpoint can exist ahead of the on-chain merkle tree, so an
    // index beyond count-1 is a forged/ahead pointer. Reject it rather than let
    // it poison peerMax.
    if (onchainCount !== undefined && latestIndex > onchainCount - 1) {
      rootLogger.warn(
        `[${chain}] ${address} latest index ${latestIndex} exceeds on-chain count ${onchainCount}; rejecting`,
      );
      return { status: 'unverified', index: -1 };
    }

    const signed = await validator.getCheckpoint(latestIndex);
    if (!signed) {
      rootLogger.warn(
        `[${chain}] ${address} advertised index ${latestIndex} but no signed checkpoint is present`,
      );
      return { status: 'unverified', index: -1 };
    }

    const recovered = BaseValidator.recoverAddress(signed);
    const { checkpoint } = signed.value;
    const domainId = multiProvider.getDomainId(chain);
    if (
      !eqAddress(recovered, address) ||
      checkpoint.index !== latestIndex ||
      checkpoint.mailbox_domain !== domainId ||
      !eqAddress(
        bytes32ToAddress(checkpoint.merkle_tree_hook_address),
        addresses.merkleTreeHook,
      )
    ) {
      rootLogger.warn(
        `[${chain}] ${address} checkpoint failed verification ` +
          `(signer ${recovered}, domain ${checkpoint.mailbox_domain} vs ${domainId}, ` +
          `hook ${checkpoint.merkle_tree_hook_address}, index ${checkpoint.index} vs ${latestIndex})`,
      );
      return { status: 'unverified', index: -1 };
    }

    return { status: 'ok', index: latestIndex };
  } catch (error) {
    rootLogger.debug(`[${chain}] ${address} unreachable: ${error}`);
    return { status: 'unreachable', index: -1 };
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

  // Resolve, read, and VERIFY each validator's latest checkpoint once per
  // (chain, address); a validator may appear in more than one set.
  const readingCache = new Map<string, Promise<CheckpointRead>>();
  const readCheckpoint = (
    chain: string,
    address: string,
  ): Promise<CheckpointRead> => {
    const key = `${chain}:${address.toLowerCase()}`;
    let cached = readingCache.get(key);
    if (!cached) {
      cached = readAndVerifyCheckpoint(
        chain,
        address,
        multiProvider,
        chainAddresses[chain],
        onchainCounts[chain],
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
            const { status, index } = await readCheckpoint(
              chain,
              validator.address,
            );
            readings.push({
              set: s.name,
              chain,
              address: validator.address,
              alias: validator.alias,
              status,
              index,
            });
          }),
        ),
    ),
  );

  // Furthest-ahead VERIFIED peer per (set, chain) for the relative diff. Only
  // 'ok' readings feed peerMax, so a forged or unverifiable pointer can never
  // inflate the peer bar and make honest validators look stalled.
  const peerMax = new Map<string, number>();
  for (const r of readings) {
    if (r.status !== 'ok') continue;
    const key = `${r.set}:${r.chain}`;
    peerMax.set(key, Math.max(peerMax.get(key) ?? -1, r.index));
  }

  const rows: ValidatorRow[] = readings.map((r) => {
    const onchainCount = onchainCounts[r.chain];
    const live = r.status === 'ok';
    // On-chain latest leaf index is count - 1.
    const lagOnchain =
      live && onchainCount !== undefined
        ? Math.max(0, onchainCount - 1 - r.index)
        : undefined;
    const peer = peerMax.get(`${r.set}:${r.chain}`);
    const lagPeer =
      live && peer !== undefined ? Math.max(0, peer - r.index) : undefined;
    const down =
      !live ||
      (lagPeer !== undefined && lagPeer >= PEER_LAG_STALL_THRESHOLD) ||
      (lagOnchain !== undefined && lagOnchain >= ONCHAIN_LAG_STALL_THRESHOLD);
    return { ...r, onchainCount, lagOnchain, lagPeer, down };
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
      const reason =
        r.status === 'unreachable'
          ? 'unreachable / no storage location'
          : r.status === 'none'
            ? 'no checkpoints signed yet'
            : r.status === 'unverified'
              ? 'checkpoint failed verification (signer/domain/hook/index)'
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
async function pushValidatorMetrics(
  rows: ValidatorRow[],
  onchainCounts: Record<string, number | undefined>,
  environment: string,
) {
  const register = new Registry();
  const labelNames = ['chain', 'validator', 'alias', 'validator_set'];

  const reachableGauge = new Gauge({
    name: 'hyperlane_validator_reachable',
    help: 'Whether a verified checkpoint could be read from the validator (1) or not (0)',
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
  // resolved) whenever onchain_read_success == 0 for a chain.
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
    const live = row.status === 'ok';
    reachableGauge.labels(labels).set(live ? 1 : 0);
    if (live) {
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
