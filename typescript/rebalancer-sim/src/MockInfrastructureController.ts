import { ethers } from 'ethers';

import type { HyperlaneCore } from '@hyperlane-xyz/sdk';
import {
  parseMessage,
  parseWarpRouteMessage,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { KPICollector } from './KPICollector.js';
import { MockActionTracker } from './runners/MockActionTracker.js';
import type {
  BridgeMockConfig,
  BridgeRouteConfig,
  DeployedDomain,
} from './types.js';
import { DEFAULT_BRIDGE_ROUTE_CONFIG } from './types.js';

const logger = rootLogger.child({ module: 'MockInfrastructureController' });

/** Default warp token scale: 10^18 for 18-decimal tokens */
const DEFAULT_WARP_TOKEN_SCALE = 10n ** 18n;

/** Pending message awaiting delayed delivery */
interface PendingMessage {
  /** keccak256(message) — real Hyperlane messageId */
  messageId: string;
  /** Full message bytes hex */
  message: string;
  destination: string;
  deliveryTime: number;
  type: 'user-transfer' | 'bridge-transfer' | 'self-rebalance';
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
    private readonly rebalancerAddress?: string,
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

    // Classify by sender — check all assets if multi-asset deployment
    let isWarp = senderLower === originDomain.warpToken.toLowerCase();
    let warpTokenScale = DEFAULT_WARP_TOKEN_SCALE;
    let senderAssetSymbol: string | undefined;
    if (originDomain.assets) {
      for (const [symbol, asset] of Object.entries(originDomain.assets)) {
        if (senderLower === asset.warpToken.toLowerCase()) {
          isWarp = true;
          warpTokenScale = asset.scale;
          senderAssetSymbol = symbol;
          break;
        }
      }
    }
    let isBridge = senderLower === originDomain.bridge.toLowerCase();
    if (originDomain.assets) {
      for (const [symbol, asset] of Object.entries(originDomain.assets)) {
        if (senderLower === asset.bridge.toLowerCase()) {
          isBridge = true;
          senderAssetSymbol = symbol;
          break;
        }
      }
    }

    if (!isWarp && !isBridge) {
      logger.warn(
        {
          sender,
          warp: originDomain.warpToken,
          bridge: originDomain.bridge,
        },
        'Unknown sender in Dispatch event',
      );
      return;
    }

    // Compute real messageId
    const messageId = ethers.utils.keccak256(message);

    // Parse message using SDK helpers
    const parsed = parseMessage(message);
    const warpBody = parseWarpRouteMessage(parsed.body);
    const recipientAddr = ethers.utils.getAddress(
      '0x' + parsed.recipient.slice(26),
    );

    // Warp tokens scale by 10^decimals, bridge Router uses scale = 1
    const scaledAmount = warpBody.amount;
    const amount = isWarp ? scaledAmount / warpTokenScale : scaledAmount;

    // Self-rebalance detection: rebalancer sending warp tokens to itself
    let type: PendingMessage['type'];
    if (isBridge) {
      type = 'bridge-transfer';
    } else if (
      this.rebalancerAddress &&
      warpBody.recipient.slice(26).toLowerCase() ===
        this.rebalancerAddress.slice(2).toLowerCase()
    ) {
      type = 'self-rebalance';
    } else {
      type = 'user-transfer';
    }

    // Calculate delivery time
    let delay: number;
    if (type === 'bridge-transfer') {
      const routeConfig = this.getRouteConfig(originChain, destChain);
      delay = this.calculateBridgeDelay(routeConfig);
    } else {
      // Both user-transfer and self-rebalance go through warp/Hyperlane
      delay = this.userTransferDelay;
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

    if (type === 'bridge-transfer' || type === 'self-rebalance') {
      // Record rebalance start in KPI (both bridge and self-rebalance are rebalancer actions)
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

      // Resolve destination asset for cross-asset transfers.
      // The message recipient is the destination warp token address.
      let destAssetSymbol = senderAssetSymbol;
      const destDomain = this.domains[destChain];
      if (destDomain?.assets && senderAssetSymbol) {
        for (const [symbol, asset] of Object.entries(destDomain.assets)) {
          if (asset.warpToken.toLowerCase() === recipientAddr.toLowerCase()) {
            destAssetSymbol = symbol;
            break;
          }
        }
      }

      this.actionTracker?.addTransfer(
        messageId,
        this.core.multiProvider.getDomainId(originChain),
        this.core.multiProvider.getDomainId(destChain),
        amount,
        senderAssetSymbol
          ? {
              sourceAsset: senderAssetSymbol,
              destinationAsset: destAssetSymbol,
            }
          : undefined,
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
          } else if (
            msg.type === 'bridge-transfer' ||
            msg.type === 'self-rebalance'
          ) {
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
            {
              messageId: msg.messageId,
              dest: msg.destination,
              error,
            },
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
          } else if (
            msg.type === 'bridge-transfer' ||
            msg.type === 'self-rebalance'
          ) {
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
