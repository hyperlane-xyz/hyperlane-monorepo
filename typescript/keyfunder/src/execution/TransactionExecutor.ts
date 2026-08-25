import { ethers } from 'ethers';
import { NonceManager } from './NonceManager';
import { GasPriceManager } from './GasPriceManager';
import { SignerFactory } from './SignerFactory';
import { StrategyRouter } from '../strategies/StrategyRouter';
import { MultiProtocolBalanceMonitor } from '../core/MultiProtocolBalanceMonitor';
import {
  ChainFundingConfig,
  FunderConfig,
  FundingAction,
  FundingExecutionResult,
  GasFeeEstimates,
  KeyfunderConfig,
  StrategyExecutionContext,
} from '../types';

export interface ExecutorOptions {
  timeoutMs?: number;
  confirmations?: number;
  maxRetries?: number;
  gasBumpPercentage?: number;
  dryRun?: boolean;
}

export class TransactionExecutor {
  private nonceManager: NonceManager;
  private gasPriceManager: GasPriceManager;
  private strategyRouter: StrategyRouter;
  private balanceMonitor: MultiProtocolBalanceMonitor;
  private options: ExecutorOptions;

  constructor(
    options: ExecutorOptions = {},
    nonceManager?: NonceManager,
    gasPriceManager?: GasPriceManager,
    strategyRouter?: StrategyRouter,
    balanceMonitor?: MultiProtocolBalanceMonitor
  ) {
    this.options = {
      timeoutMs: options.timeoutMs ?? 30000,
      confirmations: options.confirmations ?? 1,
      maxRetries: options.maxRetries ?? 2,
      gasBumpPercentage: options.gasBumpPercentage ?? 20,
      dryRun: options.dryRun ?? false,
    };
    this.nonceManager = nonceManager || new NonceManager();
    this.gasPriceManager = gasPriceManager || new GasPriceManager();
    this.strategyRouter = strategyRouter || new StrategyRouter();
    this.balanceMonitor = balanceMonitor || new MultiProtocolBalanceMonitor();
  }

  public getNonceManager(): NonceManager {
    return this.nonceManager;
  }

  public getGasPriceManager(): GasPriceManager {
    return this.gasPriceManager;
  }

  public getStrategyRouter(): StrategyRouter {
    return this.strategyRouter;
  }

  /**
   * Execute single funding action
   */
  public async executeAction(
    action: FundingAction,
    chainConfig: ChainFundingConfig,
    funderConfig: FunderConfig,
    options?: ExecutorOptions
  ): Promise<FundingExecutionResult> {
    const opts = { ...this.options, ...(options || {}) };

    if (action.status === 'SKIPPED') {
      return {
        success: true,
        error: action.skipReason || 'Skipped per policy evaluation',
      };
    }

    if (opts.dryRun) {
      return {
        success: true,
        txHash: '0x' + 'dryrun'.padEnd(64, '0'),
      };
    }

    const context: StrategyExecutionContext = {
      chainConfig,
      funderConfig,
      strategyConfig: chainConfig.strategyConfig,
      dryRun: opts.dryRun,
      rpcUrl: chainConfig.rpcUrl,
    };

    switch (action.protocol) {
      case 'ethereum':
        return await this.executeEvmAction(action, context, chainConfig, funderConfig, opts);
      case 'sealevel':
        return await this.executeSolanaAction(action, context, chainConfig, funderConfig, opts);
      case 'cosmos':
        return await this.executeCosmosAction(action, context, chainConfig, funderConfig, opts);
      default:
        return {
          success: false,
          error: `Unsupported protocol ${action.protocol}`,
        };
    }
  }

  private async executeEvmAction(
    action: FundingAction,
    context: StrategyExecutionContext,
    chainConfig: ChainFundingConfig,
    funderConfig: FunderConfig,
    opts: ExecutorOptions
  ): Promise<FundingExecutionResult> {
    const rpcUrl = chainConfig.rpcUrl || 'http://127.0.0.1:8545';
    const provider = this.balanceMonitor.getEvmProvider(rpcUrl);
    const signer = await SignerFactory.getEvmSigner(funderConfig, provider);
    const funderAddress = await signer.getAddress();

    let attempts = 0;
    const maxAttempts = (opts.maxRetries ?? 2) + 1;
    let feeEstimates: GasFeeEstimates | undefined;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        // 1. Acquire nonce
        const nonce = await this.nonceManager.getAndIncrementNonce(
          action.chain,
          funderAddress,
          provider
        );

        // 2. Compute gas fees (bump if retry)
        if (!feeEstimates) {
          feeEstimates = await this.gasPriceManager.getFeeEstimates(
            provider,
            chainConfig.gasBufferMultiplier ?? 1.2
          );
        } else if (attempts > 1) {
          feeEstimates = this.gasPriceManager.bumpFeeEstimates(
            feeEstimates,
            opts.gasBumpPercentage ?? 20
          );
        }

        const gasOverrides: Record<string, any> = {
          nonce,
        };

        if (feeEstimates.maxFeePerGas !== undefined && feeEstimates.maxPriorityFeePerGas !== undefined) {
          gasOverrides.maxFeePerGas = feeEstimates.maxFeePerGas;
          gasOverrides.maxPriorityFeePerGas = feeEstimates.maxPriorityFeePerGas;
        } else if (feeEstimates.gasPrice !== undefined) {
          gasOverrides.gasPrice = feeEstimates.gasPrice;
        }

        // 3. Execute via strategy
        const signerContext = {
          signer,
          gasOverrides,
          confirmations: opts.confirmations,
        };

        const result = await this.strategyRouter.execute(action, context, signerContext);
        if (result.success) {
          return result;
        }

        // Check if error is nonce related
        const errorMsg = (result.error || '').toLowerCase();
        if (
          errorMsg.includes('nonce too low') ||
          errorMsg.includes('nonce_expired') ||
          errorMsg.includes('replacement transaction underpriced')
        ) {
          await this.nonceManager.resync(action.chain, funderAddress, provider);
        }
      } catch (err: any) {
        const errorMsg = (err.message || String(err)).toLowerCase();
        if (
          errorMsg.includes('nonce too low') ||
          errorMsg.includes('nonce_expired') ||
          errorMsg.includes('replacement transaction underpriced')
        ) {
          await this.nonceManager.resync(action.chain, funderAddress, provider);
        }
        if (attempts >= maxAttempts) {
          return {
            success: false,
            error: `Failed after ${attempts} attempts: ${err.message}`,
          };
        }
      }
    }

    return {
      success: false,
      error: `Failed to execute EVM action after ${maxAttempts} attempts`,
    };
  }

  private async executeSolanaAction(
    action: FundingAction,
    context: StrategyExecutionContext,
    chainConfig: ChainFundingConfig,
    funderConfig: FunderConfig,
    opts: ExecutorOptions
  ): Promise<FundingExecutionResult> {
    const rpcUrl = chainConfig.rpcUrl || 'https://api.mainnet-beta.solana.com';
    const connection = this.balanceMonitor.getSolanaConnection(rpcUrl);
    const keypair = SignerFactory.getSolanaKeypair(funderConfig);

    const signerContext = {
      keypair,
      connection,
    };

    return await this.strategyRouter.execute(action, context, signerContext);
  }

  private async executeCosmosAction(
    action: FundingAction,
    context: StrategyExecutionContext,
    chainConfig: ChainFundingConfig,
    funderConfig: FunderConfig,
    opts: ExecutorOptions
  ): Promise<FundingExecutionResult> {
    const rpcUrl = chainConfig.rpcUrl || 'http://127.0.0.1:26657';
    const { client, address } = await SignerFactory.getCosmosSigner(funderConfig, rpcUrl);

    const signerContext = {
      stargateClient: client,
      funderAddress: address,
    };

    return await this.strategyRouter.execute(action, context, signerContext);
  }

  /**
   * Execute multiple funding actions across chains with timeout isolation
   */
  public async executeAll(
    actions: FundingAction[],
    config: KeyfunderConfig,
    options?: ExecutorOptions
  ): Promise<FundingAction[]> {
    const rootFunder = config.funder || config.globalFunderKey;
    const results: FundingAction[] = [];

    // Group actions by chain to process sequentially per chain (to preserve nonces),
    // but in parallel across different chains (for high throughput and isolation).
    const actionsByChain: Record<string, FundingAction[]> = {};
    for (const action of actions) {
      if (!actionsByChain[action.chain]) {
        actionsByChain[action.chain] = [];
      }
      actionsByChain[action.chain].push(action);
    }

    const chainPromises = Object.entries(actionsByChain).map(
      async ([chainName, chainActions]) => {
        const chainConfig = config.chains[chainName];
        const funderConfig = chainConfig?.funderKey || rootFunder;

        const chainResults: FundingAction[] = [];

        for (const action of chainActions) {
          if (action.status !== 'PENDING') {
            chainResults.push(action);
            continue;
          }

          if (!chainConfig || !funderConfig) {
            action.status = 'FAILED';
            action.error = `Missing chain or funder configuration for ${chainName}`;
            chainResults.push(action);
            continue;
          }

          try {
            const execResult = await this.executeAction(
              action,
              chainConfig,
              funderConfig,
              options
            );

            if (execResult.success) {
              action.status = 'EXECUTED';
              action.txHash = execResult.txHash;
            } else {
              action.status = 'FAILED';
              action.error = execResult.error;
            }
          } catch (err: any) {
            action.status = 'FAILED';
            action.error = err.message || String(err);
          }

          chainResults.push(action);
        }

        return chainResults;
      }
    );

    const settledChains = await Promise.all(chainPromises);
    for (const chainRes of settledChains) {
      results.push(...chainRes);
    }

    return results;
  }
}
