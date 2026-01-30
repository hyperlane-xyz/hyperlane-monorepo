import { ethers } from 'ethers';

import {
  ERC20__factory,
  HypERC20Collateral__factory,
} from '@hyperlane-xyz/core';
import { rootLogger } from '@hyperlane-xyz/utils';

import { BridgeMockController } from '../bridges/BridgeMockController.js';
import type { BridgeMockConfig } from '../bridges/types.js';
import type { MultiDomainDeploymentResult } from '../deployment/types.js';
import { KPICollector } from '../kpi/KPICollector.js';
import type { SimulationResult } from '../kpi/types.js';
import { MessageTracker } from '../mailbox/MessageTracker.js';
import type {
  IRebalancerRunner,
  RebalancerSimConfig,
} from '../rebalancer/types.js';
import type { SimulationTiming, TransferScenario } from '../scenario/types.js';

const logger = rootLogger.child({ module: 'SimulationEngine' });

/**
 * Default timing for fast simulations
 */
export const DEFAULT_TIMING: SimulationTiming = {
  userTransferDeliveryDelay: 0, // Instant for fast tests
  rebalancerPollingFrequency: 1000,
  userTransferInterval: 100,
};

/**
 * SimulationEngine orchestrates the execution of transfer scenarios
 * with rebalancer monitoring and KPI collection.
 */
export class SimulationEngine {
  private provider: ethers.providers.JsonRpcProvider;
  private bridgeController?: BridgeMockController;
  private kpiCollector?: KPICollector;
  private messageTracker?: MessageTracker;
  private isRunning = false;
  private mailboxProcessingInterval?: NodeJS.Timeout;
  private mailboxProcessingInFlight = false;

  constructor(private readonly deployment: MultiDomainDeploymentResult) {
    this.provider = new ethers.providers.JsonRpcProvider(deployment.anvilRpc);
    // Set fast polling interval for tx.wait() - ethers defaults to 4000ms
    this.provider.pollingInterval = 100;
    // Disable automatic polling (event subscriptions) but keep pollingInterval for tx.wait()
    this.provider.polling = false;
  }

  /**
   * Run a simulation with the given scenario and rebalancer
   */
  async runSimulation(
    scenario: TransferScenario,
    rebalancer: IRebalancerRunner,
    bridgeConfig: BridgeMockConfig,
    timing: SimulationTiming = DEFAULT_TIMING,
    rebalancerStrategyConfig: RebalancerSimConfig['strategyConfig'],
  ): Promise<SimulationResult> {
    const startTime = Date.now();
    this.isRunning = true;

    try {
      // Initialize components
      // Use bridgeControllerKey for bridge operations to avoid nonce conflicts
      this.bridgeController = new BridgeMockController(
        this.provider,
        this.deployment.domains,
        this.deployment.bridgeControllerKey,
        bridgeConfig,
      );

      this.kpiCollector = new KPICollector(
        this.provider,
        this.deployment.domains,
      );

      // Initialize MessageTracker for off-chain message tracking
      this.messageTracker = new MessageTracker(
        this.provider,
        this.deployment.domains,
        this.deployment.mailboxProcessorKey,
      );

      await this.kpiCollector.initialize();
      await this.messageTracker.initialize();
      await this.bridgeController.start();

      // Wire up MessageTracker events for KPI tracking
      this.messageTracker.on('message_delivered', (message) => {
        this.kpiCollector!.recordTransferComplete(message.transferId);
      });

      this.messageTracker.on('message_failed', ({ message }) => {
        // Don't record as failed yet - it will retry
        logger.debug(
          {
            messageId: message.id,
            attempts: message.attempts,
            error: message.lastError,
          },
          'Message failed, will retry',
        );
      });

      // Set up bridge event handlers for rebalance KPI tracking
      // Bridge transfers are rebalancer operations (user transfers go through warp token)
      this.bridgeController.on('transfer_initiated', (event) => {
        const rebalanceId = this.kpiCollector!.recordRebalanceStart(
          event.transfer.origin,
          event.transfer.destination,
          event.transfer.amount,
          BigInt(0), // Gas cost not tracked yet
        );
        // Link bridge transfer ID to rebalance ID for completion tracking
        this.kpiCollector!.linkBridgeTransfer(event.transfer.id, rebalanceId);
      });

      this.bridgeController.on('transfer_delivered', (event) => {
        this.kpiCollector!.recordRebalanceComplete(event.transfer.id);
      });

      this.bridgeController.on('transfer_failed', (event) => {
        this.kpiCollector!.recordRebalanceFailed(event.transfer.id);
      });

      // Build warp config for rebalancer
      const warpConfig = this.buildWarpConfig();

      // Initialize rebalancer
      const rebalancerConfig: RebalancerSimConfig = {
        pollingFrequency: timing.rebalancerPollingFrequency,
        warpConfig,
        strategyConfig: rebalancerStrategyConfig,
        deployment: this.deployment,
      };

      await rebalancer.initialize(rebalancerConfig);

      // Start rebalancer daemon
      await rebalancer.start();

      // Start periodic mailbox processing for delayed user transfer delivery
      this.startMailboxProcessing(timing.userTransferDeliveryDelay);

      // Execute transfers according to scenario
      await this.executeTransfers(scenario, timing);

      // Wait for all user transfer deliveries (respecting delay)
      // Use a timeout to prevent indefinite hanging
      await Promise.race([
        this.waitForUserTransferDeliveries(timing.userTransferDeliveryDelay),
        new Promise<void>((resolve) => setTimeout(resolve, 60000)), // 60s max
      ]);

      // Wait for bridge deliveries to complete (rebalancer transfers)
      await this.bridgeController.waitForAllDeliveries(30000);

      // Wait for rebalancer to become idle
      await rebalancer.waitForIdle(5000);

      // Generate final KPIs
      const kpis = await this.kpiCollector.generateKPIs();
      const endTime = Date.now();

      return {
        scenarioName: scenario.name,
        rebalancerName: rebalancer.name,
        startTime,
        endTime,
        duration: endTime - startTime,
        kpis,
        transferRecords: this.kpiCollector.getTransferRecords(),
        rebalanceRecords: this.kpiCollector.getRebalanceRecords(),
      };
    } finally {
      // Always cleanup, even if we timeout or error
      this.isRunning = false;
      this.stopMailboxProcessing();

      try {
        await rebalancer.stop();
      } catch {
        // Ignore stop errors
      }

      if (this.bridgeController) {
        try {
          await this.bridgeController.stop();
        } catch {
          // Ignore stop errors
        }
      }

      if (this.messageTracker) {
        this.messageTracker.removeAllListeners();
      }

      // Clean up provider to release connections
      this.provider.removeAllListeners();
      // Force polling to stop
      this.provider.polling = false;
    }
  }

  /**
   * Execute transfers according to the scenario
   */
  private async executeTransfers(
    scenario: TransferScenario,
    timing: SimulationTiming,
  ): Promise<void> {
    const deployer = new ethers.Wallet(
      this.deployment.deployerKey,
      this.provider,
    );
    const startTime = Date.now();

    for (let i = 0; i < scenario.transfers.length; i++) {
      const transfer = scenario.transfers[i];

      // Wait until it's time for this transfer
      const targetTime = startTime + transfer.timestamp;
      const waitTime = targetTime - Date.now();
      if (waitTime > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }

      // Record transfer start
      this.kpiCollector!.recordTransferStart(
        transfer.id,
        transfer.origin,
        transfer.destination,
        transfer.amount,
      );

      // Execute the transfer via warp token
      const originDomain = this.deployment.domains[transfer.origin];
      const destDomain = this.deployment.domains[transfer.destination];

      const warpToken = HypERC20Collateral__factory.connect(
        originDomain.warpToken,
        deployer,
      );

      try {
        const txStartTime = Date.now();

        // Approve collateral token for warp transfer
        const collateralToken = ERC20__factory.connect(
          originDomain.collateralToken,
          deployer,
        );
        const approveTx = await collateralToken.approve(
          originDomain.warpToken,
          transfer.amount,
        );
        await approveTx.wait();

        const approveTime = Date.now() - txStartTime;

        // Quote gas payment (mock mailbox should return 0)
        const gasPayment = await warpToken.quoteGasPayment(destDomain.domainId);

        // Transfer remote
        const recipientBytes32 = ethers.utils.hexZeroPad(transfer.user, 32);
        const transferTx = await warpToken.transferRemote(
          destDomain.domainId,
          recipientBytes32,
          transfer.amount,
          { value: gasPayment },
        );
        await transferTx.wait();

        const totalTxTime = Date.now() - txStartTime;

        // Log slow transfers (>1000ms suggests significant RPC contention)
        if (totalTxTime > 1000) {
          logger.warn(
            { transferId: transfer.id, totalTxTime, approveTime },
            'Slow transfer detected',
          );
        }

        // Track message for delayed delivery via MessageTracker
        await this.messageTracker!.trackMessage(
          transfer.id,
          transfer.origin,
          transfer.destination,
          timing.userTransferDeliveryDelay,
        );
      } catch (error: any) {
        logger.error(
          { transferId: transfer.id, error: error.reason || error.message },
          'Transfer failed',
        );
        this.kpiCollector!.recordTransferFailed(transfer.id);
      }
    }
    logger.info('All transfers executed');
  }

  /**
   * Start periodic processing of mailbox messages (simulates relayer with delay)
   */
  private startMailboxProcessing(_deliveryDelay: number): void {
    // Process mailbox every 100ms to check for deliveries due
    const PROCESS_INTERVAL = 100;

    this.mailboxProcessingInterval = setInterval(async () => {
      // Guard against overlapping ticks to prevent nonce collisions
      if (this.mailboxProcessingInFlight) return;
      this.mailboxProcessingInFlight = true;
      try {
        await this.processReadyMailboxDeliveries();
      } finally {
        this.mailboxProcessingInFlight = false;
      }
    }, PROCESS_INTERVAL);
  }

  /**
   * Stop mailbox processing
   */
  private stopMailboxProcessing(): void {
    if (this.mailboxProcessingInterval) {
      clearInterval(this.mailboxProcessingInterval);
      this.mailboxProcessingInterval = undefined;
    }
  }

  /**
   * Process mailbox deliveries that are ready (past their delivery time)
   * Uses MessageTracker for off-chain tracking with per-message control
   */
  private async processReadyMailboxDeliveries(): Promise<void> {
    if (!this.messageTracker) return;
    await this.messageTracker.processReadyMessages();
  }

  /**
   * Wait for all pending user transfer deliveries to complete
   */
  private async waitForUserTransferDeliveries(
    _deliveryDelay: number,
    timeout: number = 30000,
  ): Promise<void> {
    if (!this.messageTracker) return;

    const startTime = Date.now();

    while (this.messageTracker.hasPendingMessages()) {
      if (Date.now() - startTime > timeout) {
        const pending = this.messageTracker.getPendingMessages();
        logger.warn(
          { pendingCount: pending.length },
          'Timeout waiting for user transfer deliveries - marking as failed',
        );
        // Mark pending messages as failed so KPIs reflect reality
        for (const msg of pending) {
          logger.warn(
            {
              messageId: msg.id,
              origin: msg.origin,
              destination: msg.destination,
              status: msg.status,
              attempts: msg.attempts,
              error: msg.lastError || 'timeout',
            },
            'Marking pending message as failed',
          );
          // Record as failed in KPI collector
          this.kpiCollector?.recordTransferFailed(msg.transferId);
        }
        // Clear pending messages so they don't block
        this.messageTracker.clear();
        break;
      }

      // Process any ready messages
      await this.processReadyMailboxDeliveries();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Build WarpCoreConfig from deployment
   */
  private buildWarpConfig(): any {
    const tokens = Object.entries(this.deployment.domains).map(
      ([chainName, domain]) => ({
        chainName,
        standard: 'HypCollateral',
        decimals: 18,
        symbol: 'SIM',
        name: 'Simulation Token',
        addressOrDenom: domain.warpToken,
        collateralAddressOrDenom: domain.collateralToken,
        connections: Object.entries(this.deployment.domains)
          .filter(([name]) => name !== chainName)
          .map(([name, d]) => ({
            token: `ethereum|${name}|${d.warpToken}`,
          })),
      }),
    );

    return { tokens };
  }

  /**
   * Reset internal tracking state (does not reset blockchain state)
   */
  reset(): void {
    // Clear message tracker state
    if (this.messageTracker) {
      this.messageTracker.clear();
    }
  }

  /**
   * Check if simulation is currently running
   */
  isSimulationRunning(): boolean {
    return this.isRunning;
  }
}
