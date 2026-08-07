import { Contract, Wallet, providers, utils } from 'ethers';
import type { Logger } from 'pino';

import {
  Address,
  BaseValidator,
  Checkpoint,
  HexString,
  messageId as computeMessageId,
} from '@hyperlane-xyz/utils';

import { ChainConfig } from './config.js';
import { TREE_DEPTH, branchRoot } from './merkle.js';
import { SignRequest, SignResponse } from './types.js';

const MAILBOX_ABI = [
  'event Dispatch(address indexed sender, uint32 indexed destination, bytes32 indexed recipient, bytes message)',
  'event DispatchId(bytes32 indexed messageId)',
];

const HOOK_ABI = [
  'function latestCheckpoint() view returns (bytes32, uint32)',
  'function root() view returns (bytes32)',
  'function count() view returns (uint32)',
];

export class VerificationError extends Error {
  constructor(
    public reason: string,
    public detail?: Record<string, unknown>,
  ) {
    super(reason);
    this.name = 'VerificationError';
  }
}

export class Verifier {
  private readonly wallet: Wallet;
  private readonly chains: Map<string, ChainContext>;

  constructor(
    privateKey: string,
    chains: Record<string, ChainConfig>,
    private readonly logger: Logger,
  ) {
    this.wallet = new Wallet(privateKey);
    this.chains = new Map(
      Object.entries(chains).map(([name, c]) => [
        name,
        new ChainContext(name, c, logger),
      ]),
    );
  }

  get address(): Address {
    return this.wallet.address;
  }

  listChains(): { name: string; config: ChainConfig }[] {
    return [...this.chains.entries()].map(([name, ctx]) => ({
      name,
      config: ctx.config,
    }));
  }

  async verifyAndSign(req: SignRequest): Promise<SignResponse> {
    const ctx = this.chains.get(req.origin);
    if (!ctx) {
      throw new VerificationError(`unknown chain '${req.origin}'`, {
        known: [...this.chains.keys()],
      });
    }

    this.logger.info(
      {
        origin: req.origin,
        txHash: req.txHash,
        messageId: req.messageId,
        leafIndex: req.leafIndex,
      },
      'verify-and-sign',
    );

    // 1. The relayer's claimed messageId must really be in the dispatch tx.
    await ctx.verifyDispatch(req.txHash, req.messageId);

    // 2. The merkle proof must reconstruct to the claimed root.
    const reconstructed = branchRoot(req.messageId, req.proof, req.leafIndex);
    if (reconstructed.toLowerCase() !== req.claimedRoot.toLowerCase()) {
      throw new VerificationError(
        'merkle proof does not reconstruct claimed root',
        {
          reconstructed,
          claimedRoot: req.claimedRoot,
          proofLength: req.proof.length,
          leafIndex: req.leafIndex,
          treeDepth: TREE_DEPTH,
        },
      );
    }

    // 3. The on-chain merkle tree at the dispatch block must agree with
    //    (claimedRoot, leafIndex). This is the trust anchor: without it,
    //    a malicious relayer could fabricate any (root, proof) pair that
    //    reconstructs cleanly but was never on-chain.
    await ctx.verifyCheckpointAtTxBlock(
      req.txHash,
      req.claimedRoot,
      req.leafIndex,
    );

    // 4. Sign the checkpoint digest expected by MessageIdMultisigIsm /
    //    MerkleRootMultisigIsm on-chain.
    const checkpoint: Checkpoint = {
      root: req.claimedRoot,
      index: req.leafIndex,
      mailbox_domain: ctx.config.domain,
      merkle_tree_hook_address: ctx.config.merkleTreeHook,
    };
    const digest = BaseValidator.messageHash(checkpoint, req.messageId);
    const signature = await this.wallet.signMessage(digest);

    return {
      validator: this.address,
      signature,
      checkpoint,
      message_id: req.messageId,
    };
  }
}

class ChainContext {
  readonly config: ChainConfig;
  readonly providers: providers.JsonRpcProvider[];
  readonly hookContract: Contract;
  private readonly mailboxIface = new utils.Interface(MAILBOX_ABI);

  constructor(
    public name: string,
    config: ChainConfig,
    private readonly logger: Logger,
  ) {
    this.config = config;
    this.providers = config.rpcUrls.map(
      (url) => new providers.JsonRpcProvider(url),
    );
    this.hookContract = new Contract(
      config.merkleTreeHook,
      HOOK_ABI,
      this.providers[0],
    );
  }

  /** Try each configured RPC until one returns a non-null receipt. */
  private async getReceiptWithFailover(
    txHash: string,
  ): Promise<providers.TransactionReceipt> {
    let lastError: unknown;
    for (const provider of this.providers) {
      try {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (receipt) return receipt;
      } catch (e) {
        lastError = e;
        this.logger.warn(
          { chain: this.name, err: e },
          'rpc getTransactionReceipt failed',
        );
      }
    }
    throw new VerificationError(`no RPC returned a receipt for tx ${txHash}`, {
      chain: this.name,
      lastError: lastError instanceof Error ? lastError.message : lastError,
    });
  }

  /**
   * Verifies that the transaction includes a Dispatch / DispatchId event from
   * the configured Mailbox whose messageId matches the request.
   */
  async verifyDispatch(
    txHash: string,
    expectedMessageId: HexString,
  ): Promise<void> {
    const receipt = await this.getReceiptWithFailover(txHash);
    if (receipt.status === 0) {
      throw new VerificationError('dispatch tx reverted', { txHash });
    }

    const mailbox = this.config.mailbox.toLowerCase();
    const dispatchTopic = this.mailboxIface.getEventTopic('Dispatch');
    const dispatchIdTopic = this.mailboxIface.getEventTopic('DispatchId');

    const dispatchIdLog = receipt.logs.find(
      (l) =>
        l.address.toLowerCase() === mailbox &&
        l.topics[0] === dispatchIdTopic &&
        l.topics[1]?.toLowerCase() === expectedMessageId.toLowerCase(),
    );
    if (!dispatchIdLog) {
      throw new VerificationError(
        'no DispatchId event for the expected messageId found in this tx',
        { txHash, expectedMessageId, mailbox: this.config.mailbox },
      );
    }

    // Cross-check: keccak256(message) === messageId. The Dispatch event is
    // emitted immediately before DispatchId in the Mailbox.
    const dispatchLog = receipt.logs
      .filter(
        (l) =>
          l.address.toLowerCase() === mailbox && l.topics[0] === dispatchTopic,
      )
      .find((l) => l.logIndex < dispatchIdLog.logIndex);
    if (!dispatchLog) {
      throw new VerificationError('Dispatch event missing from tx', {
        txHash,
      });
    }
    const decoded = this.mailboxIface.decodeEventLog(
      'Dispatch',
      dispatchLog.data,
      dispatchLog.topics,
    );
    const computed = computeMessageId(decoded.message);
    if (computed.toLowerCase() !== expectedMessageId.toLowerCase()) {
      throw new VerificationError(
        'Dispatch message hash does not match messageId',
        { computed, expectedMessageId },
      );
    }
  }

  /**
   * Verifies that `latestCheckpoint()` on the MerkleTreeHook at the dispatch
   * block returns `(claimedRoot, leafIndex)`.
   *
   * Limitation: if more than one message was dispatched in the same block,
   * `latestCheckpoint()` returns only the last one. A more complete verifier
   * would use `eth_getLogs` to enumerate `InsertedIntoTree(messageId, index)`
   * events at the precise log position. Out of scope for this prototype.
   */
  async verifyCheckpointAtTxBlock(
    txHash: string,
    claimedRoot: string,
    leafIndex: number,
  ): Promise<void> {
    const receipt = await this.getReceiptWithFailover(txHash);
    const requiredBlock = receipt.blockNumber + this.config.reorgPeriod;
    const head = await this.providers[0].getBlockNumber();
    if (head < requiredBlock) {
      throw new VerificationError('tx has not passed reorg period', {
        txBlock: receipt.blockNumber,
        head,
        requiredBlock,
        reorgPeriod: this.config.reorgPeriod,
      });
    }

    // Use the tx block itself for the checkpoint query — the hook state
    // immediately after the dispatch is what the relayer is claiming.
    const blockTag = receipt.blockNumber;
    const [onchainRoot, onchainIndex] =
      (await this.hookContract.functions.latestCheckpoint({
        blockTag,
      })) as [string, number];

    if (Number(onchainIndex) !== leafIndex) {
      throw new VerificationError(
        'on-chain latestCheckpoint index does not match leaf index at this block (multiple dispatches in same block?)',
        { onchainIndex: Number(onchainIndex), leafIndex, blockTag },
      );
    }
    if (onchainRoot.toLowerCase() !== claimedRoot.toLowerCase()) {
      throw new VerificationError('on-chain root mismatch', {
        onchainRoot,
        claimedRoot,
        blockTag,
      });
    }
  }
}
