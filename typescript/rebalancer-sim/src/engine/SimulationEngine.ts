import { ethers } from 'ethers';

import {
  ERC20__factory,
  HypERC20Collateral__factory,
} from '@hyperlane-xyz/core';

import { BridgeMockController } from '../bridges/BridgeMockController.js';
import type { BridgeMockConfig } from '../bridges/types.js';
import {
  processAllPendingMessages,
  restoreSnapshot,
} from '../deployment/SimulationDeployment.js';
import type { MultiDomainDeploymentResult } from '../deployment/types.js';
import { KPICollector } from '../kpi/KPICollector.js';
import type { SimulationResult } from '../kpi/types.js';
import type {
  IRebalancerRunner,
  RebalancerSimConfig,
} from '../rebalancer/types.js';
import type { TransferScenario } from '../scenario/types.js';

/**
 * Timing configuration for simulation
 */
export interface SimulationTiming {
  /** Bridge delivery delay in ms */
  bridgeDeliveryDelay: number;
  /** Rebalancer polling frequency in ms */
  rebalancerPollingFrequency: number;
  /** Interval between user transfers in ms */
  userTransferInterval: number;
}

/**
 * Default timing for fast simulations
 */
export const DEFAULT_TIMING: SimulationTiming = {
  bridgeDeliveryDelay: 500,
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
  private isRunning = false;

  constructor(private readonly deployment: MultiDomainDeploymentResult) {
    this.provider = new ethers.providers.JsonRpcProvider(deployment.anvilRpc);
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
        500, // Snapshot every 500ms
      );

      await this.kpiCollector.initialize();
      await this.bridgeController.start();

      // Set up bridge event handlers for KPI tracking
      this.bridgeController.on('transfer_delivered', (event) => {
        this.kpiCollector!.recordTransferComplete(event.transfer.id);
      });

      this.bridgeController.on('transfer_failed', (event) => {
        this.kpiCollector!.recordTransferFailed(event.transfer.id);
      });

      // Set up rebalancer event handlers for KPI tracking
      rebalancer.on('rebalance', (event) => {
        if (
          event.type === 'rebalance_completed' &&
          event.origin &&
          event.destination &&
          event.amount
        ) {
          this.kpiCollector!.recordRebalance(
            event.origin,
            event.destination,
            event.amount,
            BigInt(0), // Gas cost not tracked yet
            true,
          );
        } else if (
          event.type === 'rebalance_failed' &&
          event.origin &&
          event.destination
        ) {
          this.kpiCollector!.recordRebalance(
            event.origin,
            event.destination,
            BigInt(0),
            BigInt(0),
            false,
          );
        }
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

      // Start KPI snapshot collection
      this.kpiCollector.startSnapshotCollection();

      // Start rebalancer daemon
      await rebalancer.start();

      // Execute transfers according to scenario
      await this.executeTransfers(scenario, timing);

      // Wait for bridge deliveries to complete
      await this.bridgeController.waitForAllDeliveries(30000);

      // Process any pending mailbox messages
      // This delivers the user transfers to their destinations
      await processAllPendingMessages(
        this.provider,
        this.deployment.domains,
        this.deployment.deployerKey,
      );

      // Mark all pending transfers as complete since mailbox delivery is instant
      this.kpiCollector!.markAllPendingAsComplete();

      // Wait for rebalancer to become idle
      await rebalancer.waitForIdle(10000);

      // Stop components
      await rebalancer.stop();
      await this.bridgeController.stop();
      this.kpiCollector.stopSnapshotCollection();

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
        timeline: this.kpiCollector.getTimeline(),
        transferRecords: this.kpiCollector.getTransferRecords(),
        rebalanceRecords: this.kpiCollector.getRebalanceRecords(),
      };
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Execute transfers according to the scenario
   */
  private async executeTransfers(
    scenario: TransferScenario,
    _timing: SimulationTiming,
  ): Promise<void> {
    const deployer = new ethers.Wallet(
      this.deployment.deployerKey,
      this.provider,
    );
    const startTime = Date.now();

    // Process mailbox messages periodically (every 5 transfers or 500ms)
    let lastMailboxProcessTime = Date.now();
    const MAILBOX_PROCESS_INTERVAL = 500;

    for (let i = 0; i < scenario.transfers.length; i++) {
      const transfer = scenario.transfers[i];

      // Wait until it's time for this transfer
      const targetTime = startTime + transfer.timestamp;
      const waitTime = targetTime - Date.now();
      if (waitTime > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }

      // Process mailbox messages periodically to simulate relayer
      const now = Date.now();
      if (now - lastMailboxProcessTime >= MAILBOX_PROCESS_INTERVAL) {
        await processAllPendingMessages(
          this.provider,
          this.deployment.domains,
          this.deployment.deployerKey,
        );
        this.kpiCollector!.markAllPendingAsComplete();
        lastMailboxProcessTime = now;
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
      } catch (error: any) {
        console.error(
          `Transfer ${transfer.id} failed: ${error.reason || error.message}`,
        );
        this.kpiCollector!.recordTransferFailed(transfer.id);
      }
    }
    console.log('All transfers executed');
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
   * Reset state by restoring snapshot
   */
  async reset(): Promise<void> {
    await restoreSnapshot(this.provider, this.deployment.snapshotId);
  }

  /**
   * Check if simulation is currently running
   */
  isSimulationRunning(): boolean {
    return this.isRunning;
  }
}
