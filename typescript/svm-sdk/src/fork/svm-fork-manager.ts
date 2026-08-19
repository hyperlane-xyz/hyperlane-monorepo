import {
  type AddressesByLookupTableAddress,
  type Base64EncodedWireTransaction,
  type Commitment,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  decompileTransactionMessage,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  prependTransactionMessageInstructions,
} from '@solana/kit';

import {
  type ForkedChainMetadata,
  type IForkManager,
} from '@hyperlane-xyz/forking-sdk';
import {
  assert,
  concurrentMap,
  isNullish,
  pollAsync,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  type AccountInfoRpc,
  fetchAddressLookupTableState,
} from '../accounts/address-lookup-table.js';
import { DEFAULT_COMPUTE_UNITS } from '../constants.js';
import { type SolanaRpcClient, createRpc } from '../rpc.js';
import { getComputeBudgetInstructions } from '../tx.js';

import {
  FORK_IMPERSONATION_AIRDROP_LAMPORTS,
  FORK_IMPERSONATION_FEE_PAYER,
} from './impersonation.js';
import {
  type SvmForkConfig,
  type SvmForkTransaction,
} from './svm-fork-config.js';
import {
  SurfpoolDatasourceMode,
  type SurfpoolAirdrops,
  type SurfpoolNode,
  type SurfpoolNodeRunner,
  runSurfpoolNode,
} from './surfpool-node.js';

const logger = rootLogger.child({ module: 'svm-fork-manager' });

const RPC_COMMITMENT: Commitment = 'confirmed';
const POLL_INTERVAL_MS = 500;
const POLL_MAX_ATTEMPTS = 60;
const RESOLVE_ALT_CONCURRENCY = 4;

export interface SvmForkManagerConfig {
  chainName: string;
  /** Upstream (mainnet) RPC URL to fork from. */
  upstreamRpcUrl: string;
  /** Local port the fork node should bind its RPC to. */
  rpcPort: number;
  wsPort?: number;
  airdrops?: SurfpoolAirdrops;
  image?: string;
  binaryPath?: string;
  keepRunning?: boolean;
  /** Node runner; defaults to the local-binary {@link runSurfpoolNode}. */
  runNode?: SurfpoolNodeRunner;
}

const base58Encoder = getBase58Encoder();
const transactionDecoder = getTransactionDecoder();
const compiledMessageDecoder = getCompiledTransactionMessageDecoder();

/**
 * Fetches the addresses stored in each address-lookup table referenced by a
 * compiled message, producing the map kit needs to decompile the message and
 * re-compress it against the same tables. Returns `undefined` for a message
 * that uses no lookup tables (so callers can skip compression entirely).
 */
async function resolveForkLookupTables(
  rpc: AccountInfoRpc,
  compiledMessage: ReturnType<typeof compiledMessageDecoder.decode>,
): Promise<AddressesByLookupTableAddress | undefined> {
  const lookups =
    'addressTableLookups' in compiledMessage
      ? compiledMessage.addressTableLookups
      : undefined;
  if (isNullish(lookups) || lookups.length === 0) {
    return undefined;
  }

  const entries = await concurrentMap(
    RESOLVE_ALT_CONCURRENCY,
    lookups,
    async (lookup) => {
      const state = await fetchAddressLookupTableState(
        rpc,
        lookup.lookupTableAddress,
      );
      return [lookup.lookupTableAddress, state.addresses] as const;
    },
  );
  return Object.fromEntries(entries);
}

/**
 * Rebuilds the wire transaction to replay against a fork.
 *
 * `transaction_base58` is serialized without the compute-budget instruction
 * (an external executor — Squads / file submitter — prepends it from
 * `computeUnits`, defaulting to {@link DEFAULT_COMPUTE_UNITS}). Replaying it
 * verbatim leaves the tx under the runtime per-instruction default, so a tx that
 * consumes more than that (e.g. a program upgrade) fails on the fork even though
 * real execution succeeds. To match live/Squads execution exactly, every replay
 * tx is decoded and re-emitted with the same `SetComputeUnitLimit` an external
 * executor would prepend — using `computeUnits` when set, `DEFAULT_COMPUTE_UNITS`
 * otherwise (mirroring `buildTransactionMessage`/`transactionToInstructions`).
 *
 * Any address-lookup-table compression in the source tx is preserved: the
 * message is re-compressed against the same tables before compiling, so an
 * ALT-heavy tx (e.g. cross-collateral reconciliation) stays under the 1232-byte
 * packet limit instead of being re-emitted with the accounts inlined. The zero
 * DEFAULT_BLOCKHASH is preserved and accepted because the fork runs with
 * `skipBlockhashCheck` and the send uses `skipPreflight`.
 */
export async function buildForkReplayTransaction(
  rpc: AccountInfoRpc,
  transaction: SvmForkTransaction,
): Promise<Base64EncodedWireTransaction> {
  const wireBytes = base58Encoder.encode(transaction.transaction_base58);
  const decoded = transactionDecoder.decode(wireBytes);
  const units = transaction.computeUnits ?? DEFAULT_COMPUTE_UNITS;

  const compiledMessage = compiledMessageDecoder.decode(decoded.messageBytes);
  const addressLookupTables = await resolveForkLookupTables(
    rpc,
    compiledMessage,
  );

  const message = decompileTransactionMessage(compiledMessage, {
    addressesByLookupTableAddress: addressLookupTables,
  });
  const withComputeBudget = prependTransactionMessageInstructions(
    getComputeBudgetInstructions(units),
    message,
  );

  if (isNullish(addressLookupTables)) {
    return getBase64EncodedWireTransaction(
      compileTransaction(withComputeBudget),
    );
  }

  // Only versioned (v0) messages reference lookup tables, so a defined ALT map
  // implies a non-legacy message; narrow so kit's compressor accepts it.
  assert(
    withComputeBudget.version !== 'legacy',
    'address-lookup tables require a versioned (non-legacy) transaction',
  );
  const recompressed = compressTransactionMessageUsingAddressLookupTables(
    withComputeBudget,
    addressLookupTables,
  );
  return getBase64EncodedWireTransaction(compileTransaction(recompressed));
}

/**
 * Ensures the fork airdrops SOL to the fixed fork-only impersonation fee payer
 * at boot, so keyless impersonated applies can pay fees. surfpool airdrops a
 * single amount to every address, so the fee payer is merged into the caller's
 * address list and the amount is raised to at least the impersonation buffer.
 */
export function withImpersonationAirdrop(
  airdrops: SurfpoolAirdrops | undefined,
): SurfpoolAirdrops {
  const feePayer = FORK_IMPERSONATION_FEE_PAYER.address;

  if (!airdrops) {
    return {
      addresses: [feePayer],
      lamports: FORK_IMPERSONATION_AIRDROP_LAMPORTS,
    };
  }

  const addresses = airdrops.addresses.includes(feePayer)
    ? airdrops.addresses
    : [...airdrops.addresses, feePayer];
  const lamports =
    airdrops.lamports > FORK_IMPERSONATION_AIRDROP_LAMPORTS
      ? airdrops.lamports
      : FORK_IMPERSONATION_AIRDROP_LAMPORTS;

  return { addresses, lamports };
}

class RunningSvmFork {
  constructor(
    readonly node: SurfpoolNode,
    readonly rpc: SolanaRpcClient,
    readonly rpcUrl: string,
  ) {}
}

async function startSvmFork(
  config: SvmForkManagerConfig,
): Promise<RunningSvmFork> {
  const runNode: SurfpoolNodeRunner = config.runNode ?? runSurfpoolNode;
  const node = await runNode({
    datasource: {
      mode: SurfpoolDatasourceMode.Fork,
      rpcUrl: config.upstreamRpcUrl,
    },
    rpcPort: config.rpcPort,
    wsPort: config.wsPort,
    airdrops: withImpersonationAirdrop(config.airdrops),
    skipSignatureVerification: true,
    skipBlockhashCheck: true,
    image: config.image,
    binaryPath: config.binaryPath,
    keepRunning: config.keepRunning,
  });

  return new RunningSvmFork(node, createRpc(node.rpcUrl), node.rpcUrl);
}

export class SvmForkManager implements IForkManager<SvmForkConfig> {
  private running?: RunningSvmFork;

  constructor(private readonly config: SvmForkManagerConfig) {}

  private get requireRunning(): RunningSvmFork {
    const running = this.running;
    assert(running, `Fork not started for chain ${this.config.chainName}`);
    return running;
  }

  async start(): Promise<void> {
    this.running = await startSvmFork(this.config);
  }

  async applyForkConfig(config: SvmForkConfig): Promise<void> {
    const { rpc } = this.requireRunning;

    for (const transaction of config.transactions) {
      await this.submitTransaction(rpc, transaction);
    }
  }

  getForkedChainMetadata(): ForkedChainMetadata {
    return {
      rpcUrls: [{ http: this.requireRunning.rpcUrl }],
      blocks: { confirmations: 1 },
    };
  }

  kill(): void {
    this.running?.node.kill();
  }

  private async submitTransaction(
    rpc: SolanaRpcClient,
    transaction: SvmForkTransaction,
  ): Promise<void> {
    const wireTransaction = await buildForkReplayTransaction(rpc, transaction);

    logger.debug(
      { annotation: transaction.annotation },
      'replaying transaction against fork',
    );
    const signature = await rpc
      .sendTransaction(wireTransaction, {
        encoding: 'base64',
        skipPreflight: true,
        maxRetries: 0n,
        preflightCommitment: RPC_COMMITMENT,
      })
      .send();

    const status = await pollAsync(
      async () => {
        const { value } = await rpc.getSignatureStatuses([signature]).send();
        const result = value[0];
        assert(result, `transaction ${signature} not processed yet`);
        // A failed tx is terminal: resolve immediately so the assert below
        // surfaces the failure instead of polling until the attempts run out.
        if (!isNullish(result.err)) {
          return result;
        }
        // kit 6.x can report `processed` before `confirmed`; wait for the
        // configured commitment so a dependent next tx doesn't race an
        // unconfirmed one.
        const confirmation = result.confirmationStatus;
        assert(
          confirmation === RPC_COMMITMENT || confirmation === 'finalized',
          `transaction ${signature} not yet ${RPC_COMMITMENT} (status: ${confirmation})`,
        );
        return result;
      },
      POLL_INTERVAL_MS,
      POLL_MAX_ATTEMPTS,
    );
    assert(
      isNullish(status.err),
      `fork replay transaction ${signature} failed: ${JSON.stringify(
        status.err,
        (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
      )}`,
    );

    if (transaction.waitForSlotAdvance) {
      const confirmedSlot = status.slot;
      await pollAsync(
        async () => {
          const slot = await rpc.getSlot({ commitment: RPC_COMMITMENT }).send();
          assert(
            slot > confirmedSlot,
            `slot ${slot} has not advanced past ${confirmedSlot}`,
          );
        },
        POLL_INTERVAL_MS,
        POLL_MAX_ATTEMPTS,
      );
    }
  }
}

export function createSvmForkManager(
  config: SvmForkManagerConfig,
): SvmForkManager {
  return new SvmForkManager(config);
}
