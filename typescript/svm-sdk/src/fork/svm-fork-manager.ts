import {
  type Commitment,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
} from '@solana/kit';

import {
  type ForkedChainMetadata,
  type IForkManager,
} from '@hyperlane-xyz/forking-sdk';
import { assert, isNullish, pollAsync, rootLogger } from '@hyperlane-xyz/utils';

import { type SolanaRpcClient, createRpc } from '../rpc.js';

import {
  type SvmForkConfig,
  type SvmForkTransaction,
} from './svm-fork-config.js';
import {
  SurfpoolDatasourceMode,
  type SurfpoolAirdrops,
  type SurfpoolNode,
  runSurfpoolNode,
} from './surfpool-node.js';

const logger = rootLogger.child({ module: 'svm-fork-manager' });

const RPC_COMMITMENT: Commitment = 'confirmed';
const SLOT_ADVANCE_POLL_MS = 500;
const SLOT_ADVANCE_MAX_ATTEMPTS = 60;

export interface SvmForkManagerConfig {
  chainName: string;
  /** Upstream (mainnet) RPC URL to fork from. */
  upstreamRpcUrl: string;
  /** Local port the fork node should bind its RPC to. */
  rpcPort: number;
  wsPort?: number;
  airdrops?: SurfpoolAirdrops;
  /** Tear the fork node down after replaying the fork config. */
  killAfterApply?: boolean;
  image?: string;
  binaryPath?: string;
  keepRunning?: boolean;
}

const base58Encoder = getBase58Encoder();
const transactionDecoder = getTransactionDecoder();

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
  const node = await runSurfpoolNode({
    datasource: {
      mode: SurfpoolDatasourceMode.Fork,
      rpcUrl: config.upstreamRpcUrl,
    },
    rpcPort: config.rpcPort,
    wsPort: config.wsPort,
    airdrops: config.airdrops,
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

    if (this.config.killAfterApply) {
      this.kill();
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
    const wireBytes = base58Encoder.encode(transaction.transaction_base58);
    const decoded = transactionDecoder.decode(wireBytes);
    const wireTransaction = getBase64EncodedWireTransaction(decoded);

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
        return result;
      },
      SLOT_ADVANCE_POLL_MS,
      SLOT_ADVANCE_MAX_ATTEMPTS,
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
        SLOT_ADVANCE_POLL_MS,
        SLOT_ADVANCE_MAX_ATTEMPTS,
      );
    }
  }
}

export function createSvmForkManager(
  config: SvmForkManagerConfig,
): SvmForkManager {
  return new SvmForkManager(config);
}
