import { ethers } from 'ethers';

import { MockMailbox__factory } from '@hyperlane-xyz/core';
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
 * MockInfrastructureController listens for Dispatch events on all MockMailboxes,
 * classifies messages by sender (warp vs bridge), and delivers them with
 * configurable delays by calling process('0x', message) on the destination mailbox.
 *
 * Auto-tracks both user transfers and bridge transfers from Dispatch events —
 * no external registration needed.
 */
export class MockInfrastructureController {
  private pendingMessages: PendingMessage[] = [];
  private signer: ethers.Wallet;
  private isRunning = false;
  private processing = false;
  private processLoopTimer?: NodeJS.Timeout;
  private eventListeners: Map<string, ethers.Contract> = new Map();
  private currentNonce: number = 0;
  private nonceInitialized = false;

  constructor(
    provider: ethers.providers.JsonRpcProvider,
    private readonly domains: Record<string, DeployedDomain>,
    mailboxProcessorKey: string,
    private readonly bridgeDelayConfig: BridgeMockConfig,
    private readonly userTransferDelay: number,
    private readonly kpiCollector: KPICollector,
    private readonly actionTracker?: MockActionTracker,
  ) {
    this.signer = new ethers.Wallet(mailboxProcessorKey, provider);
  }

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

  private getDomainId(chainName: string): number {
    return this.domains[chainName].domainId;
  }

  private getChainByDomainId(domainId: number): string | undefined {
    return Object.entries(this.domains).find(
      ([_, d]) => d.domainId === domainId,
    )?.[0];
  }

  /**
   * Start listening for Dispatch events and processing messages
   */
  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    // Initialize signer nonce
    this.currentNonce = await this.signer.getTransactionCount();
    this.nonceInitialized = true;

    // Listen for Dispatch events on all mailboxes
    for (const [chainName, domain] of Object.entries(this.domains)) {
      const mailbox = MockMailbox__factory.connect(domain.mailbox, this.signer);

      // Dispatch(address indexed sender, uint32 indexed destination, bytes32 indexed recipient, bytes message)
      // ethers v5 typechain: callback args are (sender, destination, recipient, message, event)
      mailbox.on(
        mailbox.filters.Dispatch(),
        (
          sender: string,
          destination: number,
          _recipient: string,
          message: string,
        ) => {
          void this.onDispatch(chainName, sender, destination, message);
        },
      );

      this.eventListeners.set(chainName, mailbox);
    }

    // Start processing loop
    this.processLoopTimer = setInterval(() => {
      void this.processReadyMessages();
    }, 50);
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
    const destChain = this.getChainByDomainId(destinationDomainId);
    if (!destChain) {
      logger.error({ destinationDomainId }, 'Unknown destination domain');
      return;
    }

    const originDomain = this.domains[originChain];
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

    // Decode amount from body (offset 77 bytes into message)
    const bodyOffset = 77;
    const body = '0x' + message.slice(2 + bodyOffset * 2);
    let amount = 0n;
    try {
      const decoded = ethers.utils.defaultAbiCoder.decode(
        ['bytes32', 'uint256'],
        body,
      );
      amount = decoded[1].toBigInt();
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
        this.getDomainId(originChain),
        this.getDomainId(destChain),
        amount,
      );
    }

    this.pendingMessages.push(pending);
  }

  /**
   * Process messages that are past their delivery time.
   * Retries indefinitely — waitForAllDeliveries handles the timeout.
   */
  private async processReadyMessages(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      await this.doProcessReadyMessages();
    } finally {
      this.processing = false;
    }
  }

  private async doProcessReadyMessages(): Promise<void> {
    const now = Date.now();
    const ready = this.pendingMessages.filter((m) => m.deliveryTime <= now);
    if (ready.length === 0) return;

    if (!this.nonceInitialized) {
      this.currentNonce = await this.signer.getTransactionCount();
      this.nonceInitialized = true;
    }

    for (const msg of ready) {
      const destDomain = this.domains[msg.destination];
      const mailbox = MockMailbox__factory.connect(
        destDomain.mailbox,
        this.signer,
      );

      // Static call pre-check
      try {
        await mailbox.callStatic.process('0x', msg.message);
      } catch {
        msg.attempts++;
        msg.deliveryTime = now + 200;
        continue;
      }

      try {
        const tx = await mailbox.process('0x', msg.message, {
          nonce: this.currentNonce++,
        });
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
          if (this.actionTracker && msg.amount) {
            this.actionTracker.completeRebalanceByRoute(
              this.getDomainId(msg.origin),
              this.getDomainId(msg.destination),
              msg.amount,
            );
          }
        }
      } catch (error) {
        msg.attempts++;
        msg.deliveryTime = now + 200;
        // Re-sync nonce on tx failure
        this.currentNonce = await this.signer.getTransactionCount();
        logger.debug(
          { messageId: msg.messageId, dest: msg.destination, error },
          'Delivery tx failed, will retry',
        );
      }
    }
  }

  /**
   * Stop listening and processing
   */
  async stop(): Promise<void> {
    this.isRunning = false;

    if (this.processLoopTimer) {
      clearInterval(this.processLoopTimer);
      this.processLoopTimer = undefined;
    }

    for (const contract of this.eventListeners.values()) {
      contract.removeAllListeners();
    }
    this.eventListeners.clear();
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
            if (this.actionTracker && msg.amount) {
              this.actionTracker.completeRebalanceByRoute(
                this.getDomainId(msg.origin),
                this.getDomainId(msg.destination),
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
