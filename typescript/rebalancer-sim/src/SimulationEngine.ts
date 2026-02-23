import { ethers } from 'ethers';

import {
  ERC20__factory,
  HypERC20Collateral__factory,
  MultiCollateral__factory,
} from '@hyperlane-xyz/core';
import {
  type ChainMetadata,
  HyperlaneCore,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { KPICollector } from './KPICollector.js';
import { MockInfrastructureController } from './MockInfrastructureController.js';
import type {
  BridgeMockConfig,
  IRebalancerRunner,
  MultiDomainDeploymentResult,
  RebalancerSimConfig,
  SimulationResult,
  SimulationTiming,
  TransferScenario,
} from './types.js';

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
  private isRunning = false;

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

    let controller: MockInfrastructureController | undefined;

    try {
      // Initialize KPI collector
      const kpiCollector = new KPICollector(
        this.provider,
        this.deployment.domains,
      );
      await kpiCollector.initialize();

      // Get action tracker from rebalancer if supported
      const actionTracker = rebalancer.getActionTracker?.();

      // Build HyperlaneCore for the controller (manages MultiProvider + Mailboxes)
      const core = this.buildHyperlaneCore();

      // Create unified controller
      controller = new MockInfrastructureController(
        core,
        this.deployment.domains,
        bridgeConfig,
        timing.userTransferDeliveryDelay,
        kpiCollector,
        actionTracker,
      );
      await controller.start();

      // Initialize rebalancer
      const rebalancerConfig: RebalancerSimConfig = {
        pollingFrequency: timing.rebalancerPollingFrequency,
        strategyConfig: rebalancerStrategyConfig,
        deployment: this.deployment,
      };

      await rebalancer.initialize(rebalancerConfig);
      await rebalancer.start();

      // Execute transfers according to scenario
      await this.executeTransfers(scenario, timing, kpiCollector);

      // Wait for ethers event polling to catch up
      await new Promise((r) => setTimeout(r, 200));

      // Wait for all deliveries (user transfers + bridge transfers)
      await controller.waitForAllDeliveries(60000);

      // Wait for rebalancer to become idle
      await rebalancer.waitForIdle(5000);

      // Generate final KPIs
      const kpis = await kpiCollector.generateKPIs();
      const endTime = Date.now();

      return {
        scenarioName: scenario.name,
        rebalancerName: rebalancer.name,
        startTime,
        endTime,
        duration: endTime - startTime,
        kpis,
        transferRecords: kpiCollector.getTransferRecords(),
        rebalanceRecords: kpiCollector.getRebalanceRecords(),
      };
    } finally {
      this.isRunning = false;

      try {
        await rebalancer.stop();
      } catch (error: unknown) {
        logger.debug({ error }, 'Rebalancer stop failed during cleanup');
      }

      if (controller) {
        try {
          await controller.stop();
        } catch (error: unknown) {
          logger.debug({ error }, 'Controller stop failed during cleanup');
        }
      }

      // Clean up provider to release connections
      this.provider.removeAllListeners();
      this.provider.polling = false;
    }
  }

  /**
   * Execute transfers according to the scenario.
   * Handles single-asset (transferRemote), cross-asset (transferRemoteTo),
   * and same-chain swaps (transferRemoteTo with localDomain).
   */
  private async executeTransfers(
    scenario: TransferScenario,
    timing: SimulationTiming,
    kpiCollector: KPICollector,
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

      const originDomain = this.deployment.domains[transfer.origin];
      const destDomain = this.deployment.domains[transfer.destination];

      // Determine if this is a cross-asset transfer
      const isCrossAsset =
        transfer.sourceAsset &&
        transfer.destinationAsset &&
        transfer.sourceAsset !== transfer.destinationAsset;

      // Resolve source warp token and collateral addresses
      let sourceWarpAddr: string;
      let sourceCollateralAddr: string;
      if (transfer.sourceAsset && originDomain.assets?.[transfer.sourceAsset]) {
        const asset = originDomain.assets[transfer.sourceAsset];
        sourceWarpAddr = asset.warpToken;
        sourceCollateralAddr = asset.collateralToken;
      } else {
        sourceWarpAddr = originDomain.warpToken;
        sourceCollateralAddr = originDomain.collateralToken;
      }

      try {
        const txStartTime = Date.now();

        // Approve collateral token
        const collateralToken = ERC20__factory.connect(
          sourceCollateralAddr,
          deployer,
        );
        const approveTx = await collateralToken.approve(
          sourceWarpAddr,
          transfer.amount,
        );
        await approveTx.wait();

        const approveTime = Date.now() - txStartTime;
        const recipientBytes32 = ethers.utils.hexZeroPad(transfer.user, 32);

        if (isCrossAsset) {
          // Cross-asset: use MultiCollateral.transferRemoteTo
          const mc = MultiCollateral__factory.connect(sourceWarpAddr, deployer);

          // Resolve destination warp token (target router)
          const destAsset = destDomain.assets?.[transfer.destinationAsset!];
          if (!destAsset) {
            throw new Error(
              `No asset ${transfer.destinationAsset} on ${transfer.destination}`,
            );
          }
          const targetRouter = ethers.utils.hexZeroPad(destAsset.warpToken, 32);

          const transferTx = await mc.transferRemoteTo(
            destDomain.domainId,
            recipientBytes32,
            transfer.amount,
            targetRouter,
          );
          await transferTx.wait();

          // Same-chain cross-asset swaps are instant (handle() called directly).
          // No Dispatch event is emitted, so manually track as completed.
          if (transfer.origin === transfer.destination) {
            kpiCollector.recordTransferStart(
              transfer.id,
              transfer.origin,
              transfer.destination,
              transfer.amount,
            );
            kpiCollector.recordTransferComplete(transfer.id);
          }
          // Cross-chain cross-asset: controller will track via Dispatch event
        } else {
          // Same-asset: standard transferRemote
          const warpToken = HypERC20Collateral__factory.connect(
            sourceWarpAddr,
            deployer,
          );
          const gasPayment = await warpToken.quoteGasPayment(
            destDomain.domainId,
          );
          const transferTx = await warpToken.transferRemote(
            destDomain.domainId,
            recipientBytes32,
            transfer.amount,
            { value: gasPayment },
          );
          await transferTx.wait();
        }

        const totalTxTime = Date.now() - txStartTime;
        if (totalTxTime > 1000) {
          logger.warn(
            { transferId: transfer.id, totalTxTime, approveTime },
            'Slow transfer detected',
          );
        }
      } catch (error) {
        logger.error(
          {
            transferId: transfer.id,
            error: error instanceof Error ? error.message : String(error),
          },
          'Transfer failed',
        );
        kpiCollector.recordTransferStart(
          transfer.id,
          transfer.origin,
          transfer.destination,
          transfer.amount,
        );
        kpiCollector.recordTransferFailed(transfer.id);
      }
    }
    logger.info('All transfers executed');
  }

  /**
   * Build a HyperlaneCore for the infrastructure controller with the
   * mailbox processor signer set on all chains.
   */
  private buildHyperlaneCore(): HyperlaneCore {
    const chainMetadata: Record<string, ChainMetadata> = {};
    const addressesMap: Record<string, { mailbox: string }> = {};
    for (const [chainName, domain] of Object.entries(this.deployment.domains)) {
      chainMetadata[chainName] = {
        name: chainName,
        chainId: 31337,
        domainId: domain.domainId,
        protocol: ProtocolType.Ethereum,
        rpcUrls: [{ http: this.deployment.anvilRpc }],
        nativeToken: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      };
      addressesMap[chainName] = { mailbox: domain.mailbox };
    }

    const multiProvider = new MultiProvider(chainMetadata);
    const processorWallet = new ethers.Wallet(
      this.deployment.mailboxProcessorKey,
      this.provider,
    );
    multiProvider.setSharedSigner(processorWallet);

    // Set fast polling on internal providers
    for (const chainName of multiProvider.getKnownChainNames()) {
      const p = multiProvider.tryGetProvider(chainName);
      if (p && 'pollingInterval' in p) {
        (p as ethers.providers.JsonRpcProvider).pollingInterval = 100;
      }
    }

    return HyperlaneCore.fromAddressesMap(addressesMap, multiProvider);
  }

  /**
   * Check if simulation is currently running
   */
  isSimulationRunning(): boolean {
    return this.isRunning;
  }
}
