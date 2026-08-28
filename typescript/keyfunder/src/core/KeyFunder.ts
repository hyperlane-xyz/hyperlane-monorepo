import { ethers } from 'ethers';
import { MultiProtocolBalanceMonitor } from './MultiProtocolBalanceMonitor';
import { PolicyEvaluator } from './PolicyEvaluator';
import { TransactionExecutor } from '../execution/TransactionExecutor';
import { SignerFactory } from '../execution/SignerFactory';
import { KeyfunderMetrics } from '../metrics/metrics';
import { getDefaultDecimals, getDefaultSymbol } from '../config/schema';
import {
  ChainBalanceReport,
  FundingAction,
  KeyfunderConfig,
  StrategyType,
} from '../types';

export interface KeyfunderOptions {
  balanceMonitor?: MultiProtocolBalanceMonitor;
  policyEvaluator?: PolicyEvaluator;
  executor?: TransactionExecutor;
  metrics?: KeyfunderMetrics;
}

export class KeyFunder {
  public readonly config: KeyfunderConfig;
  public readonly balanceMonitor: MultiProtocolBalanceMonitor;
  public readonly policyEvaluator: PolicyEvaluator;
  public readonly executor: TransactionExecutor;
  public readonly metrics: KeyfunderMetrics;

  private isRunning: boolean = false;
  private timer?: NodeJS.Timeout;

  constructor(config: KeyfunderConfig, options: KeyfunderOptions = {}) {
    this.config = config;
    this.balanceMonitor = options.balanceMonitor || new MultiProtocolBalanceMonitor();
    this.policyEvaluator = options.policyEvaluator || new PolicyEvaluator();
    this.executor =
      options.executor ||
      new TransactionExecutor(
        { dryRun: config.dryRun },
        undefined,
        undefined,
        undefined,
        this.balanceMonitor
      );
    this.metrics = options.metrics || new KeyfunderMetrics();
  }

  /**
   * Resolve public funder address for each configured chain
   */
  public async getFunderAddresses(): Promise<Record<string, string>> {
    const addresses: Record<string, string> = {};
    const rootFunder = this.config.funder || this.config.globalFunderKey;

    for (const [chainName, chainConfig] of Object.entries(this.config.chains)) {
      const funder = chainConfig.funderKey || rootFunder;
      if (!funder) {
        addresses[chainName] = '';
        continue;
      }
      try {
        addresses[chainName] = await SignerFactory.getFunderAddress(chainConfig.protocol, funder);
      } catch (err: any) {
        console.warn(`[KeyFunder] Failed to get funder address for ${chainName}: ${err.message}`);
        addresses[chainName] = '';
      }
    }

    return addresses;
  }

  /**
   * Check balances and evaluate policies without executing transactions
   */
  public async check(
    configOverride?: Partial<KeyfunderConfig>
  ): Promise<{ reports: Record<string, ChainBalanceReport>; actions: FundingAction[] }> {
    const effectiveConfig = { ...this.config, ...(configOverride || {}) };
    const funderAddresses = await this.getFunderAddresses();

    const reports = await this.balanceMonitor.getAllBalances(effectiveConfig, funderAddresses);
    const actions = this.policyEvaluator.evaluateAll(effectiveConfig, reports);

    this.metrics.recordBalances(reports);
    this.metrics.lastCycleTimestamp.set(Math.floor(Date.now() / 1000));

    return { reports, actions };
  }

  /**
   * Run a single complete funding cycle
   */
  public async runOnce(
    configOverride?: Partial<KeyfunderConfig>
  ): Promise<{ reports: Record<string, ChainBalanceReport>; actions: FundingAction[] }> {
    const startCycle = Date.now();
    const effectiveConfig = { ...this.config, ...(configOverride || {}) };
    const isDryRun = effectiveConfig.dryRun ?? false;

    const { reports, actions } = await this.check(effectiveConfig);

    const pendingActions = actions.filter((a) => a.status === 'PENDING');
    let executedActions: FundingAction[] = actions;

    if (pendingActions.length > 0) {
      if (isDryRun) {
        executedActions = actions.map((a) => {
          if (a.status === 'PENDING') {
            return {
              ...a,
              status: 'EXECUTED',
              txHash: '0x' + 'dryrun'.padEnd(64, '0'),
            };
          }
          return a;
        });
      } else {
        executedActions = await this.executor.executeAll(actions, effectiveConfig, {
          dryRun: false,
        });
      }
    }

    // Record metrics
    // Dry-run actions must not touch the cumulative funding-amount counter.
    if (!isDryRun) {
      this.metrics.recordActions(executedActions);
    }
    const durationSeconds = (Date.now() - startCycle) / 1000;
    this.metrics.cycleDurationSeconds.observe(durationSeconds);
    this.metrics.lastCycleTimestamp.set(Math.floor(Date.now() / 1000));

    return {
      reports,
      actions: executedActions,
    };
  }

  /**
   * Start daemon running continuous funding cycles
   */
  public async startDaemon(intervalSec?: number): Promise<void> {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;

    const interval =
      intervalSec ??
      this.config.intervalSec ??
      this.config.daemonIntervalSeconds ??
      60;

    if (this.config.metricsPort) {
      await this.metrics.startServer(this.config.metricsPort);
    }

    const runLoop = async () => {
      if (!this.isRunning) return;
      try {
        await this.runOnce();
      } catch (err: any) {
        console.error(`[KeyFunder Daemon] Error in funding cycle: ${err.message}`);
        this.metrics.recordError('daemon', 'cycle_failure');
      }

      if (this.isRunning) {
        this.timer = setTimeout(runLoop, interval * 1000);
      }
    };

    // Run first cycle immediately
    await runLoop();
  }

  /**
   * Stop continuous daemon mode
   */
  public async stopDaemon(): Promise<void> {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.metrics.stopServer();
  }

  /**
   * Perform manual top-up for a single recipient
   */
  public async topUpRecipient(
    chainName: string,
    recipientAddress: string,
    amountStr: string,
    strategyOverride?: StrategyType,
    dryRun: boolean = false
  ): Promise<FundingAction> {
    const chainConfig = this.config.chains[chainName];
    if (!chainConfig) {
      throw new Error(`Chain ${chainName} is not configured`);
    }

    const rootFunder = this.config.funder || this.config.globalFunderKey;
    const funderConfig = chainConfig.funderKey || rootFunder;
    if (!funderConfig) {
      throw new Error(`No funder key configured for chain ${chainName}`);
    }

    const decimals = chainConfig.nativeDecimals ?? getDefaultDecimals(chainConfig.protocol);
    const symbol = chainConfig.nativeSymbol ?? getDefaultSymbol(chainConfig.protocol);
    const requiredFunding = ethers.parseUnits(amountStr, decimals);

    const funderAddress = await SignerFactory.getFunderAddress(chainConfig.protocol, funderConfig);
    const currentBalance = await this.balanceMonitor.getNativeBalance(chainConfig, recipientAddress);
    const funderBalance = await this.balanceMonitor.getNativeBalance(chainConfig, funderAddress);

    const strategy = strategyOverride || chainConfig.strategy || 'direct';

    const action: FundingAction = {
      chain: chainName,
      protocol: chainConfig.protocol,
      recipient: recipientAddress,
      currentBalance,
      formattedCurrentBalance: ethers.formatUnits(currentBalance, decimals),
      minThreshold: 0n,
      formattedMinThreshold: '0',
      desiredBalance: currentBalance + requiredFunding,
      formattedDesiredBalance: ethers.formatUnits(currentBalance + requiredFunding, decimals),
      requiredFunding,
      formattedRequiredFunding: amountStr,
      funderAddress,
      funderBalance,
      formattedFunderBalance: ethers.formatUnits(funderBalance, decimals),
      strategy,
      status: 'PENDING',
      decimals,
      symbol,
    };

    if (dryRun) {
      action.status = 'EXECUTED';
      action.txHash = '0x' + 'dryrun_topup'.padEnd(64, '0');
      return action;
    }

    const execResult = await this.executor.executeAction(action, chainConfig, funderConfig);
    if (execResult.success) {
      action.status = 'EXECUTED';
      action.txHash = execResult.txHash;
    } else {
      action.status = 'FAILED';
      action.error = execResult.error;
    }

    this.metrics.recordActions([action]);
    return action;
  }
}
