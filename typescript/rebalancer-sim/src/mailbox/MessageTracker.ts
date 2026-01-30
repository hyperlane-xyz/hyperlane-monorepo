import { ethers } from 'ethers';
import { EventEmitter } from 'events';

import { MockMailbox__factory } from '@hyperlane-xyz/core';
import { rootLogger } from '@hyperlane-xyz/utils';

import type { DeployedDomain } from '../deployment/types.js';

const logger = rootLogger.child({ module: 'MessageTracker' });

/**
 * Tracked message for off-chain processing control
 */
export interface TrackedMessage {
  id: string;
  transferId: string;
  origin: string;
  destination: string;
  /** Nonce on the destination mailbox */
  destinationNonce: number;
  /** When the message was dispatched */
  dispatchedAt: number;
  /** When we should attempt delivery */
  deliveryTime: number;
  /** Processing status */
  status: 'pending' | 'inflight' | 'delivered' | 'failed';
  /** Number of delivery attempts */
  attempts: number;
  /** Last error if failed */
  lastError?: string;
}

/**
 * MessageTracker provides off-chain tracking and selective processing
 * of Hyperlane messages. Fires transactions in parallel without blocking
 * on receipts, similar to how the Hyperlane relayer batches messages.
 */
export class MessageTracker extends EventEmitter {
  private messages: Map<string, TrackedMessage> = new Map();
  private messageCounter = 0;
  private destinationNonces: Map<string, number> = new Map();
  private signer: ethers.Wallet;
  private currentNonce: number = 0;
  private nonceInitialized = false;

  constructor(
    private readonly provider: ethers.providers.JsonRpcProvider,
    private readonly domains: Record<string, DeployedDomain>,
    signerKey: string,
  ) {
    super();
    this.signer = new ethers.Wallet(signerKey, provider);
  }

  /**
   * Initialize by fetching current nonces from all destination mailboxes
   */
  async initialize(): Promise<void> {
    for (const [chainName, domain] of Object.entries(this.domains)) {
      const mailbox = MockMailbox__factory.connect(
        domain.mailbox,
        this.provider,
      );
      const nonce = await mailbox.inboundUnprocessedNonce();
      this.destinationNonces.set(chainName, Number(nonce));
    }
    // Initialize signer nonce for parallel tx submission
    this.currentNonce = await this.signer.getTransactionCount();
    this.nonceInitialized = true;
  }

  /**
   * Track a new message after a transfer is initiated.
   * Call this after transferRemote() succeeds.
   */
  async trackMessage(
    transferId: string,
    origin: string,
    destination: string,
    deliveryDelay: number,
  ): Promise<TrackedMessage> {
    const destDomain = this.domains[destination];
    const mailbox = MockMailbox__factory.connect(
      destDomain.mailbox,
      this.provider,
    );
    await mailbox.inboundUnprocessedNonce(); // Verify mailbox is accessible

    const expectedNonce = this.destinationNonces.get(destination) || 0;
    this.destinationNonces.set(destination, expectedNonce + 1);

    const message: TrackedMessage = {
      id: `msg-${this.messageCounter++}`,
      transferId,
      origin,
      destination,
      destinationNonce: expectedNonce,
      dispatchedAt: Date.now(),
      deliveryTime: Date.now() + deliveryDelay,
      status: 'pending',
      attempts: 0,
    };

    this.messages.set(message.id, message);
    this.emit('message_tracked', message);

    return message;
  }

  /**
   * Get all messages ready for delivery (past their delivery time, not inflight)
   */
  getReadyMessages(): TrackedMessage[] {
    const now = Date.now();
    return Array.from(this.messages.values()).filter(
      (m) => m.status === 'pending' && m.deliveryTime <= now,
    );
  }

  /**
   * Get all pending messages (including not yet ready and inflight)
   */
  getPendingMessages(): TrackedMessage[] {
    return Array.from(this.messages.values()).filter(
      (m) => m.status === 'pending' || m.status === 'inflight',
    );
  }

  /**
   * Process all ready messages in parallel without blocking on receipts.
   * Fires transactions and subscribes to completion asynchronously.
   */
  async processReadyMessages(): Promise<{ delivered: number; failed: number }> {
    const ready = this.getReadyMessages();
    if (ready.length === 0) {
      return { delivered: 0, failed: 0 };
    }

    // Ensure nonce is initialized
    if (!this.nonceInitialized) {
      this.currentNonce = await this.signer.getTransactionCount();
      this.nonceInitialized = true;
    }

    // Check which messages can actually be processed (have sufficient liquidity)
    // by doing a static call first
    const processable: TrackedMessage[] = [];

    const checkStartTime = Date.now();
    for (const message of ready) {
      const destDomain = this.domains[message.destination];
      const mailbox = MockMailbox__factory.connect(
        destDomain.mailbox,
        this.signer,
      );

      const staticCallStart = Date.now();
      try {
        // Static call to check if it would succeed
        await mailbox.callStatic.processInboundMessage(
          message.destinationNonce,
        );
        const staticCallDuration = Date.now() - staticCallStart;
        if (staticCallDuration > 100) {
          logger.warn(
            { transferId: message.transferId, staticCallDuration },
            'Slow static call',
          );
        }
        processable.push(message);
        // Log successful processing after retries
        if (message.attempts > 0) {
          const waitTime = Date.now() - message.dispatchedAt;
          logger.debug(
            {
              transferId: message.transferId,
              origin: message.origin,
              destination: message.destination,
              attempts: message.attempts,
              waitTime,
            },
            'Message ready after retries',
          );
        }
      } catch (error: any) {
        const staticCallDuration = Date.now() - staticCallStart;
        const errorMsg = error.reason || error.message || '';
        // Check if message was already delivered (e.g., by bridge controller)
        // This is a permanent state, not a temporary error
        if (errorMsg.includes('already delivered')) {
          message.status = 'delivered';
          this.emit('message_delivered', message);
          continue;
        }
        // Other errors - mark attempt but keep pending for retry
        message.attempts++;
        message.lastError = errorMsg;

        // Log failures - every 5 attempts or on slow static calls
        if (message.attempts % 5 === 0 || staticCallDuration > 100) {
          const waitTime = Date.now() - message.dispatchedAt;
          logger.debug(
            {
              transferId: message.transferId,
              origin: message.origin,
              destination: message.destination,
              attempts: message.attempts,
              waitTime,
              error: errorMsg,
            },
            'Message delivery failed, will retry',
          );
        }
      }
    }

    const totalCheckTime = Date.now() - checkStartTime;
    if (totalCheckTime > 500) {
      logger.warn(
        { messageCount: ready.length, totalCheckTime },
        'Slow static call checks',
      );
    }

    if (processable.length === 0) {
      // No messages processable yet - not a failure, they will retry
      return { delivered: 0, failed: 0 };
    }

    // Fire all processable transactions in parallel
    const txPromises: Array<{
      message: TrackedMessage;
      txPromise: Promise<ethers.ContractTransaction>;
    }> = [];

    for (const message of processable) {
      message.status = 'inflight';
      message.attempts++;

      const destDomain = this.domains[message.destination];
      const mailbox = MockMailbox__factory.connect(
        destDomain.mailbox,
        this.signer,
      );

      // Fire transaction with explicit nonce (don't wait)
      const txPromise = mailbox.processInboundMessage(
        message.destinationNonce,
        { nonce: this.currentNonce++ },
      );

      txPromises.push({ message, txPromise });
    }

    // Subscribe to all tx completions asynchronously
    let delivered = 0;
    let failed = 0;

    await Promise.all(
      txPromises.map(async ({ message, txPromise }) => {
        try {
          const tx = await txPromise;
          await tx.wait();

          message.status = 'delivered';
          this.emit('message_delivered', message);
          delivered++;
        } catch (error: any) {
          // Transaction failed - back to pending for retry
          message.status = 'pending';
          message.lastError = error.reason || error.message;
          failed++;
        }
      }),
    );

    return { delivered, failed };
  }

  /**
   * Check if there are any pending or inflight messages
   */
  hasPendingMessages(): boolean {
    return this.getPendingMessages().length > 0;
  }

  /**
   * Get message by transfer ID
   */
  getMessageByTransferId(transferId: string): TrackedMessage | undefined {
    return Array.from(this.messages.values()).find(
      (m) => m.transferId === transferId,
    );
  }

  /**
   * Get all messages
   */
  getAllMessages(): TrackedMessage[] {
    return Array.from(this.messages.values());
  }

  /**
   * Clear all tracked messages (for reset)
   */
  clear(): void {
    this.messages.clear();
    this.messageCounter = 0;
    this.destinationNonces.clear();
    this.nonceInitialized = false;
  }
}
