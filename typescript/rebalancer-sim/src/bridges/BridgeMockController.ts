import { ethers } from 'ethers';
import { EventEmitter } from 'events';

import {
  ERC20Test__factory,
  MockValueTransferBridge__factory,
} from '@hyperlane-xyz/core';
import type { Address } from '@hyperlane-xyz/utils';
import { rootLogger } from '@hyperlane-xyz/utils';

import type { DeployedDomain } from '../deployment/types.js';

import type {
  BridgeEvent,
  BridgeMockConfig,
  BridgeRouteConfig,
  PendingTransfer,
} from './types.js';
import { DEFAULT_BRIDGE_ROUTE_CONFIG } from './types.js';

const logger = rootLogger.child({ module: 'BridgeMockController' });

/**
 * BridgeMockController manages simulated bridge transfers with configurable
 * delays, failures, and fees. It intercepts SentTransferRemote events and
 * schedules async delivery to simulate real bridge behavior.
 */
export class BridgeMockController extends EventEmitter {
  private pendingTransfers: Map<string, PendingTransfer> = new Map();
  private completedTransfers: PendingTransfer[] = [];
  private transferCounter = 0;
  private deliveryTimers: Map<string, NodeJS.Timeout> = new Map();
  private isRunning = false;
  private eventListeners: Map<string, ethers.Contract> = new Map();

  // Transaction queue to prevent nonce collisions
  private txQueue: Array<() => Promise<void>> = [];
  private txProcessing = false;

  constructor(
    private readonly provider: ethers.providers.JsonRpcProvider,
    private readonly domains: Record<string, DeployedDomain>,
    private readonly deployerKey: string,
    private readonly bridgeConfig: BridgeMockConfig = {},
  ) {
    super();
  }

  /**
   * Queue a transaction to be executed serially (prevents nonce collisions)
   */
  private async queueTransaction(fn: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.txQueue.push(async () => {
        try {
          await fn();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      void this.processQueue();
    });
  }

  /**
   * Process queued transactions one at a time
   */
  private async processQueue(): Promise<void> {
    if (this.txProcessing || this.txQueue.length === 0) return;

    this.txProcessing = true;
    while (this.txQueue.length > 0) {
      const fn = this.txQueue.shift();
      if (fn) {
        try {
          await fn();
        } catch (_error) {
          // Error already handled in queueTransaction
        }
      }
    }
    this.txProcessing = false;
  }

  /**
   * Gets the bridge config for a specific route
   */
  private getRouteConfig(
    origin: string,
    destination: string,
  ): BridgeRouteConfig {
    return (
      this.bridgeConfig[origin]?.[destination] ?? DEFAULT_BRIDGE_ROUTE_CONFIG
    );
  }

  /**
   * Calculates delivery delay with jitter
   */
  private calculateDelay(config: BridgeRouteConfig): number {
    const jitter = (Math.random() - 0.5) * 2 * config.deliveryJitter;
    return Math.max(0, config.deliveryDelay + jitter);
  }

  /**
   * Start listening for bridge events
   */
  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    const deployer = new ethers.Wallet(this.deployerKey, this.provider);

    // Set up event listeners for each bridge
    for (const [chainName, domain] of Object.entries(this.domains)) {
      const bridge = MockValueTransferBridge__factory.connect(
        domain.bridge,
        deployer,
      );

      // Listen for SentTransferRemote events
      bridge.on(
        bridge.filters.SentTransferRemote(),
        (origin, destination, recipient, amount) => {
          void this.onTransferInitiated(
            chainName,
            origin,
            destination,
            recipient,
            amount.toBigInt(),
          );
        },
      );

      this.eventListeners.set(chainName, bridge);
    }
  }

  /**
   * Stop listening and cancel pending deliveries
   */
  async stop(): Promise<void> {
    this.isRunning = false;

    // Remove event listeners
    for (const bridge of this.eventListeners.values()) {
      bridge.removeAllListeners();
    }
    this.eventListeners.clear();

    // Cancel pending delivery timers
    for (const timer of this.deliveryTimers.values()) {
      clearTimeout(timer);
    }
    this.deliveryTimers.clear();
  }

  /**
   * Handle transfer initiated event
   */
  private async onTransferInitiated(
    originChain: string,
    originDomainId: number,
    destinationDomainId: number,
    recipientBytes32: string,
    amount: bigint,
  ): Promise<void> {
    // Find destination chain by domain ID
    const destChain = Object.entries(this.domains).find(
      ([_, d]) => d.domainId === destinationDomainId,
    )?.[0];

    if (!destChain) {
      logger.error({ destinationDomainId }, 'Unknown destination domain');
      return;
    }

    const config = this.getRouteConfig(originChain, destChain);
    const transferId = `bridge-${this.transferCounter++}`;
    const delay = this.calculateDelay(config);

    // Apply token fee if configured
    let netAmount = amount;
    if (config.tokenFeeBps) {
      const fee = (amount * BigInt(config.tokenFeeBps)) / BigInt(10000);
      netAmount = amount - fee;
    }

    const recipient = ethers.utils.hexDataSlice(
      recipientBytes32,
      12,
    ) as Address;

    // MockValueTransferBridge pulls tokens from origin warp token.
    // Bridge delivery mints to destination, preserving total warp token collateral.

    const pendingTransfer: PendingTransfer = {
      id: transferId,
      origin: originChain,
      destination: destChain,
      amount: netAmount,
      recipient,
      scheduledDelivery: Date.now() + delay,
      failed: false,
      delivered: false,
    };

    this.pendingTransfers.set(transferId, pendingTransfer);

    // Emit event
    const bridgeEvent: BridgeEvent = {
      type: 'transfer_initiated',
      transfer: pendingTransfer,
      timestamp: Date.now(),
    };
    this.emit('transfer_initiated', bridgeEvent);

    // Schedule delivery
    const timer = setTimeout(
      () => this.executeDelivery(transferId, config),
      delay,
    );
    this.deliveryTimers.set(transferId, timer);
  }

  /**
   * Execute delivery of a pending transfer
   */
  private async executeDelivery(
    transferId: string,
    config: BridgeRouteConfig,
  ): Promise<void> {
    const transfer = this.pendingTransfers.get(transferId);
    if (!transfer || transfer.delivered) return;

    this.deliveryTimers.delete(transferId);

    // Check for failure
    if (Math.random() < config.failureRate) {
      transfer.failed = true;
      this.pendingTransfers.delete(transferId);
      this.completedTransfers.push(transfer);

      const event: BridgeEvent = {
        type: 'transfer_failed',
        transfer,
        timestamp: Date.now(),
      };
      this.emit('transfer_failed', event);
      return;
    }

    try {
      // Execute the delivery by simulating tokens arriving at destination
      // In a real scenario, this would call the destination warp token's handle function
      // For simulation, we directly transfer tokens to simulate bridge completion
      await this.simulateBridgeDelivery(transfer);

      transfer.delivered = true;
      transfer.deliveredAt = Date.now();
      this.pendingTransfers.delete(transferId);
      this.completedTransfers.push(transfer);

      const event: BridgeEvent = {
        type: 'transfer_delivered',
        transfer,
        timestamp: Date.now(),
      };
      this.emit('transfer_delivered', event);
    } catch (error) {
      logger.error({ transferId, error }, 'Bridge delivery failed');
      transfer.failed = true;
      this.pendingTransfers.delete(transferId);
      this.completedTransfers.push(transfer);

      const event: BridgeEvent = {
        type: 'transfer_failed',
        transfer,
        timestamp: Date.now(),
      };
      this.emit('transfer_failed', event);
    }
  }

  /**
   * Simulate bridge delivery by minting tokens at destination.
   * Uses transaction queue to prevent nonce collisions.
   */
  private async simulateBridgeDelivery(
    transfer: PendingTransfer,
  ): Promise<void> {
    await this.queueTransaction(async () => {
      const deployer = new ethers.Wallet(this.deployerKey, this.provider);
      const destDomain = this.domains[transfer.destination];

      // Mint tokens to destination warp token to simulate tokens arriving
      const destCollateralToken = ERC20Test__factory.connect(
        destDomain.collateralToken,
        deployer,
      );
      const mintTx = await destCollateralToken.mintTo(
        destDomain.warpToken,
        transfer.amount.toString(),
      );
      await mintTx.wait();
    });
  }

  /**
   * Manually trigger delivery for a pending transfer (for testing)
   */
  async forceDelivery(transferId: string): Promise<void> {
    const transfer = this.pendingTransfers.get(transferId);
    if (!transfer) {
      throw new Error(`Transfer not found: ${transferId}`);
    }

    // Cancel scheduled delivery
    const timer = this.deliveryTimers.get(transferId);
    if (timer) {
      clearTimeout(timer);
      this.deliveryTimers.delete(transferId);
    }

    // Execute immediately
    await this.executeDelivery(
      transferId,
      this.getRouteConfig(transfer.origin, transfer.destination),
    );
  }

  /**
   * Check if there are pending transfers
   */
  hasPendingTransfers(): boolean {
    return this.pendingTransfers.size > 0;
  }

  /**
   * Get count of pending transfers
   */
  getPendingCount(): number {
    return this.pendingTransfers.size;
  }

  /**
   * Get all pending transfers
   */
  getPendingTransfers(): PendingTransfer[] {
    return Array.from(this.pendingTransfers.values());
  }

  /**
   * Get completed transfers
   */
  getCompletedTransfers(): PendingTransfer[] {
    return [...this.completedTransfers];
  }

  /**
   * Wait for all pending transfers to complete
   * On timeout, marks remaining transfers as failed and clears them
   */
  async waitForAllDeliveries(timeoutMs: number = 30000): Promise<void> {
    const startTime = Date.now();

    while (this.hasPendingTransfers()) {
      if (Date.now() - startTime > timeoutMs) {
        const pendingCount = this.getPendingCount();
        logger.warn(
          { pendingCount },
          'Timeout waiting for bridge deliveries - marking as failed',
        );
        // Mark all pending as failed, update state, and clear
        for (const transfer of this.pendingTransfers.values()) {
          transfer.failed = true;
          this.completedTransfers.push(transfer);
          const event: BridgeEvent = {
            type: 'transfer_failed',
            transfer,
            timestamp: Date.now(),
          };
          this.emit('transfer_failed', event);
        }
        this.pendingTransfers.clear();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
