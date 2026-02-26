import { ethers } from 'ethers';

import type { HyperlaneCore } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { KPICollector } from './KPICollector.js';
import { MockActionTracker } from './runners/MockActionTracker.js';
import type {
  BridgeMockConfig,
  BridgeRouteConfig,
  DeployedDomain,
} from './types.js';
import { DEFAULT_BRIDGE_ROUTE_CONFIG } from './types.js';

const logger = rootLogger.child({ module: 'MockInfrastructureController' });

/** Hyperlane message body starts at byte offset 77 (version:1 + nonce:4 + origin:4 + sender:32 + dest:4 + recipient:32) */
const MESSAGE_BODY_OFFSET = 77;
/** Warp tokens scale amounts by 10^decimals; simulation uses 18 decimals */
const WARP_TOKEN_SCALE = BigInt(1e18);

/** Pending message awaiting delayed delivery */
interface PendingMessage {
  /** keccak256(message) — real Hyperlane messageId */
  messageId: string;
  /** Full message bytes hex */
  message: string;
  destination: string;
  deliveryTime: number;
  type: 'user-transfer' | 'bridge-transfer';
  /** Origin chain name */
  origin: string;
  /** Decoded amount from body */
  amount: bigint;
  /** Number of delivery attempts */
  attempts: number;
}

/**
 * MockInfrastructureController listens for Dispatch events on all Mailboxes,
 * classifies messages by sender (warp vs bridge), and delivers them with
 * configurable delays by calling process('0x', message) on the destination mailbox.
 *
 * Auto-tracks both user transfers and bridge transfers from Dispatch events —
 * no external registration needed.
 */
export class MockInfrastructureController {
  private pendingMessages: PendingMessage[] = [];
  private isRunning = false;
  private processLoopPromise?: Promise<void>;

  constructor(
    private readonly core: HyperlaneCore,
    private readonly domains: Record<string, DeployedDomain>,
    private readonly bridgeDelayConfig: BridgeMockConfig,
    private readonly userTransferDelay: number,
    private readonly kpiCollector: KPICollector,
    private readonly actionTracker?: MockActionTracker,
  ) {}

  private getRouteConfig(
    origin: string,
    destination: string,
  ): BridgeRouteConfig {
    return (
      this.bridgeDelayConfig[origin]?.[destination] ??
      DEFAULT_BRIDGE_ROUTE_CONFIG
    );
  }

  private calculateBridgeDelay(config: BridgeRouteConfig): number {
    const jitter = (Math.random() - 0.5) * 2 * config.deliveryJitter;
    return Math.max(0, config.deliveryDelay + jitter);
  }

  /**
   * Start listening for Dispatch events and processing messages
   */
  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    // Listen for Dispatch events on all mailboxes
    for (const chainName of this.core.multiProvider.getKnownChainNames()) {
      const mailbox = this.core.getContracts(chainName).mailbox;
      mailbox.on(
        mailbox.filters.Dispatch(),
        (
          sender: string,
          destination: number,
          _recipient: string,
          message: string,
        ) => {
          this.onDispatch(chainName, sender, destination, message).catch(
            (error: unknown) => {
              logger.error(
                { origin: chainName, error },
                'Unhandled error in onDispatch',
              );
            },
          );
        },
      );
    }

    // Start processing loop
    this.processLoopPromise = this.processLoop();
  }

  /**
   * Handle a Dispatch event
   */
  private async onDispatch(
    originChain: string,
    sender: string,
    destinationDomainId: number,
    message: string,
  ): Promise<void> {
    const destChain =
      this.core.multiProvider.tryGetChainName(destinationDomainId);
    if (!destChain) {
      logger.error({ destinationDomainId }, 'Unknown destination domain');
      return;
    }

    const originDomain = this.domains[originChain];
    if (!originDomain) {
      logger.warn(
        { originChain },
        'No domain config for origin chain, skipping',
      );
      return;
    }
    const senderLower = sender.toLowerCase();

    // Classify by sender
    const isWarp = senderLower === originDomain.warpToken.toLowerCase();
    const isBridge = senderLower === originDomain.bridge.toLowerCase();

    if (!isWarp && !isBridge) {
      logger.warn(
        { sender, warp: originDomain.warpToken, bridge: originDomain.bridge },
        'Unknown sender in Dispatch event',
      );
      return;
    }

    const type = isWarp ? 'user-transfer' : 'bridge-transfer';

    // Compute real messageId
    const messageId = ethers.utils.keccak256(message);

    const body = '0x' + message.slice(2 + MESSAGE_BODY_OFFSET * 2);
    let amount = 0n;
    try {
      const decoded = ethers.utils.defaultAbiCoder.decode(
        ['bytes32', 'uint256'],
        body,
      );
      const scaledAmount = decoded[1].toBigInt();
      // Warp tokens use scale = 10^decimals, bridge Router uses scale = 1 (no scaling)
      amount =
        type === 'user-transfer'
          ? scaledAmount / WARP_TOKEN_SCALE
          : scaledAmount;
    } catch (error) {
      logger.warn(
        { messageId, origin: originChain, dest: destChain, error },
        'Failed to decode message amount',
      );
    }

    // Calculate delivery time
    let delay: number;
    if (type === 'user-transfer') {
      delay = this.userTransferDelay;
    } else {
      const routeConfig = this.getRouteConfig(originChain, destChain);
      delay = this.calculateBridgeDelay(routeConfig);
    }

    const pending: PendingMessage = {
      messageId,
      message,
      destination: destChain,
      deliveryTime: Date.now() + delay,
      type,
      origin: originChain,
      amount,
      attempts: 0,
    };

    if (type === 'bridge-transfer') {
      // Record rebalance start in KPI
      const rebalanceId = this.kpiCollector.recordRebalanceStart(
        originChain,
        destChain,
        amount,
        0n,
      );
      this.kpiCollector.linkBridgeTransfer(messageId, rebalanceId);
    } else {
      // User transfer: auto-track from event
      this.kpiCollector.recordTransferStart(
        messageId,
        originChain,
        destChain,
        amount,
      );

      this.actionTracker?.addTransfer(
        messageId,
        this.core.multiProvider.getDomainId(originChain),
        this.core.multiProvider.getDomainId(destChain),
        amount,
      );
    }

    this.pendingMessages.push(pending);
  }

  /**
   * Async processing loop — delivers ready messages, sleeps between iterations.
   * Retries indefinitely; waitForAllDeliveries handles the timeout.
   */
  private async processLoop(): Promise<void> {
    while (this.isRunning) {
      const now = Date.now();
      const ready = this.pendingMessages.filter((m) => m.deliveryTime <= now);

      for (const msg of ready) {
        if (!this.isRunning) break;

        const mailbox = this.core.getContracts(msg.destination).mailbox;

        // Static call pre-check
        try {
          await mailbox.callStatic.process('0x', msg.message);
        } catch (error) {
          logger.debug(
            {
              messageId: msg.messageId,
              dest: msg.destination,
              attempts: msg.attempts,
              error,
            },
            'Static pre-check failed, will retry',
          );
          msg.attempts++;
          msg.deliveryTime = now + 200;
          continue;
        }

        try {
          const tx = await mailbox.process('0x', msg.message);
          await tx.wait();

          // Remove from pending
          const idx = this.pendingMessages.indexOf(msg);
          if (idx >= 0) this.pendingMessages.splice(idx, 1);

          // Record completion
          if (msg.type === 'user-transfer') {
            this.kpiCollector.recordTransferComplete(msg.messageId);
            this.actionTracker?.removeTransfer(msg.messageId);
          } else if (msg.type === 'bridge-transfer') {
            this.kpiCollector.recordRebalanceComplete(msg.messageId);
            if (this.actionTracker && msg.amount > 0n) {
              this.actionTracker.completeRebalanceByRoute(
                this.core.multiProvider.getDomainId(msg.origin),
                this.core.multiProvider.getDomainId(msg.destination),
                msg.amount,
              );
            }
          }
        } catch (error) {
          msg.attempts++;
          msg.deliveryTime = now + 200;
          logger.debug(
            { messageId: msg.messageId, dest: msg.destination, error },
            'Delivery tx failed, will retry',
          );
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /**
   * Stop listening and processing
   */
  async stop(): Promise<void> {
    this.isRunning = false;

    // Wait for the processing loop to exit
    if (this.processLoopPromise) {
      await this.processLoopPromise;
      this.processLoopPromise = undefined;
    }

    for (const chainName of this.core.multiProvider.getKnownChainNames()) {
      this.core.getContracts(chainName).mailbox.removeAllListeners();
    }
  }

  hasPendingMessages(): boolean {
    return this.pendingMessages.length > 0;
  }

  /**
   * Wait for all pending messages to be delivered
   */
  async waitForAllDeliveries(timeoutMs: number = 30000): Promise<void> {
    const startTime = Date.now();

    while (this.hasPendingMessages()) {
      if (Date.now() - startTime > timeoutMs) {
        const remaining = this.pendingMessages.length;
        logger.warn(
          { remaining },
          'Timeout waiting for deliveries - marking failures',
        );

        for (const msg of this.pendingMessages) {
          if (msg.type === 'user-transfer') {
            this.kpiCollector.recordTransferFailed(msg.messageId);
            this.actionTracker?.removeTransfer(msg.messageId);
          } else if (msg.type === 'bridge-transfer') {
            this.kpiCollector.recordRebalanceFailed(msg.messageId);
            if (this.actionTracker && msg.amount > 0n) {
              this.actionTracker.failRebalanceByRoute(
                this.core.multiProvider.getDomainId(msg.origin),
                this.core.multiProvider.getDomainId(msg.destination),
                msg.amount,
              );
            }
          }
        }
        this.pendingMessages = [];
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
