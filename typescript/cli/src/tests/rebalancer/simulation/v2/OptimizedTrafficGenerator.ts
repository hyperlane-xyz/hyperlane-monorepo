/**
 * OptimizedTrafficGenerator
 *
 * An optimized version of TrafficGenerator that minimizes contract call overhead
 * by pre-approving tokens and caching gas quotes.
 * 
 * Key fixes for batch processing:
 * - Extracts and stores actual message bytes from Dispatch event for delivery
 * - Tracks delivered message IDs to prevent re-delivery attempts
 * - Serializes all delivery transactions to avoid nonce conflicts
 */
import { BigNumber, constants } from 'ethers';

import {
  HypERC20Collateral__factory,
  HypERC20__factory,
  Mailbox__factory,
} from '@hyperlane-xyz/core';
import { Address, addressToBytes32 } from '@hyperlane-xyz/utils';

import type { RebalancerTestSetup } from '../../harness/setup.js';
import type { PendingWarpTransfer, ScheduledTransfer } from './types.js';

/**
 * Optimized traffic generator that minimizes contract calls.
 * Uses dedicated signers to avoid nonce conflicts:
 * - traffic signer: executes user transfers
 * - relayer signer: delivers Hyperlane messages
 */
export class OptimizedTrafficGenerator {
  private gasQuoteCache = new Map<number, BigNumber>(); // domainId -> quote
  private approvedRoutes = new Set<string>(); // "origin" keys
  private deliveredMessageIds = new Set<string>(); // Track delivered messages

  // Use dedicated signers to avoid nonce conflicts
  private get trafficSigner() {
    return this.setup.signers.traffic;
  }
  private get relayerSigner() {
    return this.setup.signers.relayer;
  }

  constructor(
    private readonly setup: RebalancerTestSetup,
    private readonly warpTransferDelayMs: number,
  ) {}

  /**
   * Initialize the generator by pre-approving all tokens and caching gas quotes.
   * Call this once before running the simulation.
   */
  async initialize(): Promise<void> {
    // Pre-approve all collateral tokens for their warp routes
    // Must do this sequentially to avoid nonce conflicts
    // Use traffic signer for approvals since it will be sending transfers
    for (const [domainName, token] of Object.entries(this.setup.tokens)) {
      const warpRouteAddress = this.setup.getWarpRouteAddress(domainName);
      
      // Connect token with traffic signer for approval
      const tokenWithTrafficSigner = token.connect(this.trafficSigner);
      const tx = await tokenWithTrafficSigner.approve(warpRouteAddress, constants.MaxUint256);
      await tx.wait();
      this.approvedRoutes.add(domainName);
    }

    // Pre-cache gas quotes for all origin -> destination pairs
    // These are read-only calls, can be done in parallel
    const quotePromises: Promise<void>[] = [];
    const domainNames = Object.keys(this.setup.domains);
    
    for (const originName of domainNames) {
      const warpRouteAddress = this.setup.getWarpRouteAddress(originName);
      const warpRoute = HypERC20Collateral__factory.connect(
        warpRouteAddress,
        this.trafficSigner,
      );

      for (const destName of domainNames) {
        if (originName === destName) continue;
        
        const destDomain = this.setup.getDomain(destName);
        
        quotePromises.push(
          warpRoute.quoteGasPayment(destDomain.domainId)
            .then(quote => {
              // Cache by destination domain ID
              this.gasQuoteCache.set(destDomain.domainId, quote);
            })
            .catch(() => {
              // Some routes may not have all destinations enrolled - that's ok
            })
        );
      }
    }

    await Promise.all(quotePromises);
  }

  /**
   * Execute a transfer with minimal overhead.
   * Assumes initialize() has been called.
   * Uses the traffic signer for transfers.
   */
  async executeTransfer(
    transfer: ScheduledTransfer,
    currentTime: number,
  ): Promise<PendingWarpTransfer> {
    const { origin, destination, amount, sender } = transfer;

    // Get warp route contract - use traffic signer
    const warpRouteAddress = this.setup.getWarpRouteAddress(origin);
    const warpRoute = HypERC20Collateral__factory.connect(
      warpRouteAddress,
      this.trafficSigner,
    );

    // Get destination domain ID
    const destDomain = this.setup.getDomain(destination).domainId;

    // Determine recipient - use traffic signer address by default
    const recipientAddress = sender ?? this.trafficSigner.address;
    const recipientBytes32 = addressToBytes32(recipientAddress);

    // Use cached gas quote (or fetch if not cached)
    let quote = this.gasQuoteCache.get(destDomain);
    if (!quote) {
      quote = await warpRoute.quoteGasPayment(destDomain);
      this.gasQuoteCache.set(destDomain, quote);
    }

    // Execute transfer (no approval needed - already done in initialize)
    const tx = await warpRoute.transferRemote(
      destDomain,
      recipientBytes32,
      amount,
      { value: quote },
    );
    const receipt = await tx.wait();

    // Extract message ID and message bytes from dispatch event
    const { messageId, messageBytes } = this.extractMessageFromReceipt(receipt);

    return {
      messageId,
      messageBytes,
      txHash: tx.hash,
      origin,
      destination,
      amount,
      sender: this.trafficSigner.address as Address,
      recipient: recipientAddress as Address,
      initiatedAt: currentTime,
      expectedCompletionAt: currentTime + this.warpTransferDelayMs,
      completed: false,
    };
  }

  /**
   * Execute multiple transfers in parallel.
   * Groups transfers by origin to avoid nonce conflicts.
   */
  async executeTransfersBatch(
    transfers: Array<{ transfer: ScheduledTransfer; currentTime: number }>,
  ): Promise<PendingWarpTransfer[]> {
    // Group by origin to avoid nonce conflicts
    const byOrigin = new Map<string, Array<{ transfer: ScheduledTransfer; currentTime: number }>>();
    
    for (const item of transfers) {
      const origin = item.transfer.origin;
      if (!byOrigin.has(origin)) {
        byOrigin.set(origin, []);
      }
      byOrigin.get(origin)!.push(item);
    }

    // Execute each origin group in parallel, but within each group sequentially
    const results: PendingWarpTransfer[] = [];
    
    const groupPromises = Array.from(byOrigin.entries()).map(async ([_origin, items]) => {
      const groupResults: PendingWarpTransfer[] = [];
      for (const item of items) {
        const result = await this.executeTransfer(item.transfer, item.currentTime);
        groupResults.push(result);
      }
      return groupResults;
    });

    const groupResults = await Promise.all(groupPromises);
    for (const group of groupResults) {
      results.push(...group);
    }

    return results;
  }

  /**
   * Check if a message has already been delivered.
   */
  isDelivered(messageId: string): boolean {
    return this.deliveredMessageIds.has(messageId);
  }

  /**
   * Deliver a transfer by calling the destination mailbox.
   * Uses the actual message bytes from the Dispatch event.
   * Uses the relayer signer to avoid nonce conflicts with traffic signer.
   */
  async deliverTransfer(pending: PendingWarpTransfer): Promise<boolean> {
    // Check if already delivered
    if (this.deliveredMessageIds.has(pending.messageId)) {
      return false; // Already delivered, skip
    }

    // Ensure we have the message bytes
    if (!pending.messageBytes) {
      throw new Error(`Missing messageBytes for transfer ${pending.messageId}`);
    }

    const destDomain = this.setup.getDomain(pending.destination);

    // Use relayer signer for message delivery
    const mailbox = Mailbox__factory.connect(
      destDomain.mailbox,
      this.relayerSigner,
    );

    // Process the message using the exact bytes from the Dispatch event
    // TestISM accepts any message without verification
    const processTx = await mailbox.process('0x', pending.messageBytes);
    await processTx.wait();

    // Mark as delivered
    this.deliveredMessageIds.add(pending.messageId);
    return true;
  }

  /**
   * Deliver multiple transfers.
   * IMPORTANT: All deliveries are executed sequentially to avoid nonce conflicts.
   * This is necessary because the signer is shared across all destinations.
   */
  async deliverTransfersBatch(transfers: PendingWarpTransfer[]): Promise<{ delivered: number; skipped: number }> {
    let delivered = 0;
    let skipped = 0;

    // Filter out already delivered transfers
    const toDeliver = transfers.filter(t => !this.deliveredMessageIds.has(t.messageId));
    
    // Execute ALL deliveries sequentially to avoid nonce conflicts
    // (Even though they go to different destination mailboxes, we use the same signer)
    for (const transfer of toDeliver) {
      try {
        const wasDelivered = await this.deliverTransfer(transfer);
        if (wasDelivered) {
          delivered++;
        } else {
          skipped++;
        }
      } catch (error: any) {
        // Check if it's an "already delivered" error from the contract
        if (error.message?.includes('already delivered')) {
          this.deliveredMessageIds.add(transfer.messageId);
          skipped++;
        } else {
          throw error;
        }
      }
    }

    return { delivered, skipped };
  }

  /**
   * Extract message ID and full message bytes from a transfer receipt.
   */
  private extractMessageFromReceipt(receipt: any): { messageId: string; messageBytes: string } {
    // Dispatch event signature: Dispatch(address indexed sender, uint32 indexed destination, bytes32 indexed recipient, bytes message)
    const dispatchTopic =
      '0x769f711d20c679153d382254f59892613b58a97cc876b249134ac25c80f9c814';

    for (const log of receipt.logs) {
      if (log.topics[0] === dispatchTopic) {
        // Message ID is in the DispatchId event which comes right after Dispatch
        // But we can also compute it from the message bytes
        // For now, we look for the DispatchId event for the message ID
        const messageId = this.findDispatchId(receipt.logs, log);
        
        // The message bytes are in the data field of the Dispatch event
        // The data is ABI-encoded: offset (32 bytes) + length (32 bytes) + message bytes
        const messageBytes = this.decodeMessageFromDispatchEvent(log.data);
        
        return { messageId, messageBytes };
      }
    }

    throw new Error('Dispatch event not found in receipt');
  }

  /**
   * Find the DispatchId event that corresponds to a Dispatch event.
   */
  private findDispatchId(logs: any[], dispatchLog: any): string {
    // DispatchId event signature: DispatchId(bytes32 indexed messageId)
    // Computed via: ethers.utils.id('DispatchId(bytes32)')
    const dispatchIdTopic =
      '0x788dbc1b7152732178210e7f4d9d010ef016f9eafbe66786bd7169f56e0c353a';
    
    // The DispatchId event is emitted right after Dispatch from the same address
    const dispatchLogIndex = logs.indexOf(dispatchLog);
    
    for (let i = dispatchLogIndex; i < logs.length; i++) {
      const log = logs[i];
      if (log.topics[0] === dispatchIdTopic && log.address === dispatchLog.address) {
        return log.topics[1]; // messageId is the first indexed param
      }
    }

    // Fallback: look for any DispatchId from same address
    for (const log of logs) {
      if (log.topics[0] === dispatchIdTopic && log.address === dispatchLog.address) {
        return log.topics[1];
      }
    }

    throw new Error('DispatchId event not found');
  }

  /**
   * Decode the message bytes from a Dispatch event's data field.
   * The data is ABI-encoded as: bytes (dynamic type)
   * Format: offset (32 bytes) + length (32 bytes) + data (padded to 32-byte boundary)
   */
  private decodeMessageFromDispatchEvent(data: string): string {
    // Remove '0x' prefix if present
    const hexData = data.startsWith('0x') ? data.slice(2) : data;
    
    // First 32 bytes: offset to the data (always 0x20 = 32 for a single bytes param)
    // Next 32 bytes at offset: length of the bytes data
    const lengthHex = hexData.slice(64, 128); // bytes 32-64
    const length = parseInt(lengthHex, 16);
    
    // The actual message starts at byte 64 (after offset + length)
    // and is `length` bytes long
    const messageHex = hexData.slice(128, 128 + length * 2);
    
    return '0x' + messageHex;
  }
}
