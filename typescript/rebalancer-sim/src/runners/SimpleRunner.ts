import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { pino } from 'pino';

import {
  ERC20Test__factory,
  HypERC20Collateral__factory,
} from '@hyperlane-xyz/core';

import type {
  DeployedDomain,
  IRebalancerRunner,
  RebalancerSimConfig,
} from '../types.js';

// Track the current SimpleRunner instance for cleanup
let currentSimpleRunner: SimpleRunner | null = null;
let currentSimpleProvider: ethers.providers.JsonRpcProvider | null = null;

/**
 * Global cleanup function - call between test runs to ensure clean state
 */
export async function cleanupSimpleRunner(): Promise<void> {
  if (currentSimpleRunner) {
    const runner = currentSimpleRunner;
    currentSimpleRunner = null;
    try {
      await runner.stop();
    } catch {
      // Ignore errors
    }
  }

  if (currentSimpleProvider) {
    currentSimpleProvider.removeAllListeners();
    currentSimpleProvider = null;
  }

  // Small delay to allow any async cleanup to complete
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/**
 * SimpleRunner is a simplified rebalancer implementation for simulation testing.
 * It monitors balances and triggers rebalances when imbalances exceed thresholds.
 */
export class SimpleRunner extends EventEmitter implements IRebalancerRunner {
  readonly name = 'SimpleRebalancer';

  private config?: RebalancerSimConfig;
  private logger = pino({ level: 'warn' });
  private running = false;
  private activeOperations = 0;
  private pollingTimer?: NodeJS.Timeout;
  private provider?: ethers.providers.JsonRpcProvider;
  private deployer?: ethers.Wallet;

  async initialize(config: RebalancerSimConfig): Promise<void> {
    // Cleanup any previously running instance
    await cleanupSimpleRunner();

    this.config = config;
    this.provider = new ethers.providers.JsonRpcProvider(
      config.deployment.anvilRpc,
    );
    // Set fast polling interval for tx.wait() - ethers defaults to 4000ms
    this.provider.pollingInterval = 100;
    // Disable automatic polling to reduce RPC contention in simulation
    this.provider.polling = false;
    // Track for cleanup
    currentSimpleProvider = this.provider;

    // Use separate rebalancer key to avoid nonce conflicts with transfer execution
    this.deployer = new ethers.Wallet(
      config.deployment.rebalancerKey,
      this.provider,
    );
  }

  async start(): Promise<void> {
    if (!this.config) {
      throw new Error('Rebalancer not initialized');
    }

    if (this.running) {
      return;
    }

    this.running = true;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    currentSimpleRunner = this;
    this.logger.info('Starting rebalancer daemon');

    // Start polling loop
    this.scheduleNextPoll();
  }

  private scheduleNextPoll(): void {
    if (!this.running || !this.config) return;

    this.pollingTimer = setTimeout(async () => {
      await this.pollAndRebalance();
      this.scheduleNextPoll();
    }, this.config.pollingFrequency);
  }

  private async pollAndRebalance(): Promise<void> {
    if (!this.config || !this.provider || !this.deployer) return;

    try {
      this.activeOperations++;

      // Get current balances
      const balances: Record<string, bigint> = {};
      const domains = this.config.deployment.domains;

      for (const [chainName, domain] of Object.entries(domains)) {
        const token = ERC20Test__factory.connect(
          domain.collateralToken,
          this.provider,
        );
        const balance = await token.balanceOf(domain.warpToken);
        balances[chainName] = balance.toBigInt();
      }

      // Calculate total and target balances per strategy
      const { strategyConfig } = this.config;
      if (strategyConfig.type === 'weighted') {
        await this.executeWeightedRebalance(balances, domains);
      } else if (strategyConfig.type === 'minAmount') {
        await this.executeMinAmountRebalance(balances, domains);
      }
    } catch (error) {
      this.logger.error({ error }, 'Error during rebalance poll');
    } finally {
      this.activeOperations--;
    }
  }

  private async executeWeightedRebalance(
    balances: Record<string, bigint>,
    domains: Record<string, DeployedDomain>,
  ): Promise<void> {
    if (!this.config || !this.deployer) return;

    const { strategyConfig } = this.config;
    const chainNames = Object.keys(balances);

    // Calculate total balance
    let totalBalance = BigInt(0);
    for (const balance of Object.values(balances)) {
      totalBalance += balance;
    }

    if (totalBalance === BigInt(0)) return;

    // Calculate weight sum
    let totalWeight = 0;
    for (const chainName of chainNames) {
      const chainConfig = strategyConfig.chains[chainName];
      const weight = chainConfig?.weighted?.weight
        ? parseFloat(chainConfig.weighted.weight)
        : 1 / chainNames.length;
      totalWeight += weight;
    }

    // Find chains with excess and deficit
    const excess: { chain: string; amount: bigint }[] = [];
    const deficit: { chain: string; amount: bigint }[] = [];

    for (const chainName of chainNames) {
      const chainConfig = strategyConfig.chains[chainName];
      const weight = chainConfig?.weighted?.weight
        ? parseFloat(chainConfig.weighted.weight)
        : 1 / chainNames.length;
      const tolerance = chainConfig?.weighted?.tolerance
        ? parseFloat(chainConfig.weighted.tolerance)
        : 0.1;

      const targetBalance =
        (totalBalance * BigInt(Math.floor(weight * 10000))) /
        BigInt(Math.floor(totalWeight * 10000));
      const currentBalance = balances[chainName];

      const minBalance =
        (targetBalance * BigInt(Math.floor((1 - tolerance) * 10000))) /
        BigInt(10000);
      const maxBalance =
        (targetBalance * BigInt(Math.floor((1 + tolerance) * 10000))) /
        BigInt(10000);

      if (currentBalance > maxBalance) {
        excess.push({
          chain: chainName,
          amount: currentBalance - targetBalance,
        });
      } else if (currentBalance < minBalance) {
        deficit.push({
          chain: chainName,
          amount: targetBalance - currentBalance,
        });
      }
    }

    // Execute rebalances - track remaining amounts to avoid over-rebalancing
    const remainingExcess = new Map(excess.map((e) => [e.chain, e.amount]));
    const remainingDeficit = new Map(deficit.map((d) => [d.chain, d.amount]));

    for (const { chain: fromChain } of excess) {
      for (const { chain: toChain } of deficit) {
        const currentExcess = remainingExcess.get(fromChain) ?? BigInt(0);
        const currentDeficit = remainingDeficit.get(toChain) ?? BigInt(0);
        if (currentExcess <= BigInt(0) || currentDeficit <= BigInt(0)) continue;

        const rebalanceAmount =
          currentExcess < currentDeficit ? currentExcess : currentDeficit;
        if (rebalanceAmount > BigInt(0)) {
          await this.executeRebalance(
            fromChain,
            toChain,
            rebalanceAmount,
            domains,
          );
          remainingExcess.set(fromChain, currentExcess - rebalanceAmount);
          remainingDeficit.set(toChain, currentDeficit - rebalanceAmount);
        }
      }
    }
  }

  private async executeMinAmountRebalance(
    balances: Record<string, bigint>,
    domains: Record<string, DeployedDomain>,
  ): Promise<void> {
    if (!this.config) return;

    const { strategyConfig } = this.config;

    // Find chains below minimum
    const belowMin: { chain: string; deficit: bigint; target: bigint }[] = [];
    const aboveTarget: { chain: string; excess: bigint }[] = [];

    for (const [chainName, balance] of Object.entries(balances)) {
      const chainConfig = strategyConfig.chains[chainName];
      if (!chainConfig?.minAmount) continue;

      const min = BigInt(chainConfig.minAmount.min);
      const target = BigInt(chainConfig.minAmount.target);

      if (balance < min) {
        belowMin.push({ chain: chainName, deficit: target - balance, target });
      } else if (balance > target * BigInt(2)) {
        aboveTarget.push({ chain: chainName, excess: balance - target });
      }
    }

    // Rebalance from excess to deficit - track remaining amounts to avoid over-rebalancing
    const remainingDeficit = new Map(belowMin.map((d) => [d.chain, d.deficit]));
    const remainingExcess = new Map(
      aboveTarget.map((e) => [e.chain, e.excess]),
    );

    for (const { chain: toChain } of belowMin) {
      for (const { chain: fromChain } of aboveTarget) {
        const currentDeficit = remainingDeficit.get(toChain) ?? BigInt(0);
        const currentExcess = remainingExcess.get(fromChain) ?? BigInt(0);
        if (currentDeficit <= BigInt(0) || currentExcess <= BigInt(0)) continue;

        const amount =
          currentDeficit < currentExcess ? currentDeficit : currentExcess;
        if (amount > BigInt(0)) {
          await this.executeRebalance(fromChain, toChain, amount, domains);
          remainingDeficit.set(toChain, currentDeficit - amount);
          remainingExcess.set(fromChain, currentExcess - amount);
        }
      }
    }
  }

  private async executeRebalance(
    fromChain: string,
    toChain: string,
    amount: bigint,
    domains: Record<string, DeployedDomain>,
  ): Promise<void> {
    if (!this.deployer) return;

    try {
      const fromDomain = domains[fromChain];
      const toDomain = domains[toChain];

      this.logger.info(
        { fromChain, toChain, amount: amount.toString() },
        'Executing rebalance',
      );

      const warpToken = HypERC20Collateral__factory.connect(
        fromDomain.warpToken,
        this.deployer,
      );

      // Use the bridge to rebalance
      // Call rebalance through the warp token
      const tx = await warpToken.rebalance(
        toDomain.domainId,
        amount,
        fromDomain.bridge,
      );
      await tx.wait();

      this.emit('rebalance', {
        type: 'rebalance_completed',
        timestamp: Date.now(),
        origin: fromChain,
        destination: toChain,
        amount,
      });

      this.logger.info(
        { fromChain, toChain, amount: amount.toString(), txHash: tx.hash },
        'Rebalance completed',
      );
    } catch (error) {
      this.logger.error({ error, fromChain, toChain }, 'Rebalance failed');
      this.emit('rebalance', {
        type: 'rebalance_failed',
        timestamp: Date.now(),
        origin: fromChain,
        destination: toChain,
        error: String(error),
      });
    }
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;

    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = undefined;
    }

    // Clear global reference
    if (currentSimpleRunner === this) {
      currentSimpleRunner = null;
    }

    // Clean up provider
    if (this.provider) {
      this.provider.removeAllListeners();
      if (currentSimpleProvider === this.provider) {
        currentSimpleProvider = null;
      }
      this.provider = undefined;
    }

    this.deployer = undefined;
    this.config = undefined;
    this.removeAllListeners();

    this.logger.info('Rebalancer stopped');
  }

  isActive(): boolean {
    return this.running && this.activeOperations > 0;
  }

  async waitForIdle(timeoutMs: number = 10000): Promise<void> {
    const startTime = Date.now();

    while (this.isActive()) {
      if (Date.now() - startTime > timeoutMs) {
        throw new Error('Timeout waiting for rebalancer to become idle');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
