import type { Logger } from 'pino';
import { formatEther, parseEther } from 'viem';

import { HyperlaneIgp, MultiProvider } from '@hyperlane-xyz/sdk';

import type {
  ChainConfig,
  KeyFunderConfig,
  ResolvedKeyConfig,
} from '../config/types.js';
import type { KeyFunderMetrics } from '../metrics/Metrics.js';

const MIN_DELTA_NUMERATOR = 6n;
const MIN_DELTA_DENOMINATOR = 10n;

const CHAIN_FUNDING_TIMEOUT_MS = 60_000;

export interface KeyFunderOptions {
  logger: Logger;
  metrics?: KeyFunderMetrics;
  skipIgpClaim?: boolean;
  igp?: HyperlaneIgp;
}

export class KeyFunder {
  constructor(
    private readonly multiProvider: MultiProvider,
    private readonly config: KeyFunderConfig,
    private readonly options: KeyFunderOptions,
  ) {}

  async fundAllChains(): Promise<void> {
    const chainsToSkip = new Set(this.config.chainsToSkip ?? []);
    const chains = Object.keys(this.config.chains).filter(
      (chain) => !chainsToSkip.has(chain),
    );

    const results = await Promise.allSettled(
      chains.map((chain) => this.fundChainWithTimeout(chain)),
    );

    const failures = results
      .map((r, i) => ({ result: r, chain: chains[i] }))
      .filter(
        (entry): entry is { result: PromiseRejectedResult; chain: string } =>
          entry.result.status === 'rejected',
      );

    if (failures.length > 0) {
      const failedChains = failures.map((f) => ({
        chain: f.chain,
        error: f.result.reason?.message ?? String(f.result.reason),
      }));
      this.options.logger.error(
        { failedChains, totalChains: chains.length },
        'Some chains failed to fund',
      );
      throw new Error(
        `${failures.length}/${chains.length} chains failed to fund: ${failedChains.map((f) => f.chain).join(', ')}`,
      );
    }
  }

  private async fundChainWithTimeout(chain: string): Promise<void> {
    const { promise: timeoutPromise, cleanup } = createTimeoutPromise(
      CHAIN_FUNDING_TIMEOUT_MS,
      `Funding timed out for chain ${chain}`,
    );

    try {
      await Promise.race([this.fundChain(chain), timeoutPromise]);
    } catch (error) {
      this.options.logger.error({ chain, error }, 'Chain funding failed');
      throw error;
    } finally {
      cleanup();
    }
  }

  async fundChain(chain: string): Promise<void> {
    const chainConfig = this.config.chains[chain];
    if (!chainConfig) {
      this.options.logger.warn({ chain }, 'No config for chain, skipping');
      return;
    }

    const startTime = Date.now();
    const logger = this.options.logger.child({ chain });

    if (!this.options.skipIgpClaim && chainConfig.igp) {
      await this.claimFromIgp(chain, chainConfig);
    }

    try {
      await this.recordFunderBalance(chain);
    } catch (error) {
      logger.warn(
        { error },
        'Failed to record funder balance metric, continuing',
      );
    }

    const resolvedKeys = this.resolveKeysForChain(chain, chainConfig);
    if (resolvedKeys.length > 0) {
      await this.fundKeys(chain, resolvedKeys);
    }

    if (chainConfig.sweep?.enabled) {
      await this.sweepExcessFunds(chain, chainConfig);
    }

    const durationSeconds = (Date.now() - startTime) / 1000;
    this.options.metrics?.recordOperationDuration(
      chain,
      'fund',
      durationSeconds,
    );
    logger.info({ durationSeconds }, 'Chain funding completed');
  }

  private async recordFunderBalance(chain: string): Promise<void> {
    const signer = this.multiProvider.getSigner(chain);
    const funderAddress = await signer.getAddress();
    const funderBalance = await signer.getBalance();
    const balanceInEther = parseFloat(ethers.utils.formatEther(funderBalance));
    this.options.metrics?.recordUnifiedWalletBalance(
      chain,
      funderAddress,
      'key-funder',
      balanceInEther,
    );
  }

  private resolveKeysForChain(
    chain: string,
    chainConfig: ChainConfig,
  ): ResolvedKeyConfig[] {
    if (!chainConfig.balances) {
      return [];
    }

    const resolvedKeys: ResolvedKeyConfig[] = [];
    for (const [roleName, desiredBalance] of Object.entries(
      chainConfig.balances,
    )) {
      const roleConfig = this.config.roles[roleName];
      if (!roleConfig) {
        this.options.logger.warn(
          { chain, role: roleName },
          'Role not found in config, skipping',
        );
        continue;
      }

      resolvedKeys.push({
        address: roleConfig.address,
        role: roleName,
        desiredBalance,
      });
    }

    return resolvedKeys;
  }

  private async claimFromIgp(
    chain: string,
    chainConfig: ChainConfig,
  ): Promise<void> {
    const igpConfig = chainConfig.igp;
    if (!igpConfig || !this.options.igp) {
      return;
    }

    const logger = this.options.logger.child({ chain, operation: 'igp-claim' });
    const provider = this.multiProvider.getProvider(chain);
    const igpContract =
      this.options.igp.getContracts(chain).interchainGasPaymaster;
    const igpBalance = toBigInt(await provider.getBalance(igpContract.address));
    const claimThreshold = parseEther(igpConfig.claimThreshold);

    this.options.metrics?.recordIgpBalance(
      chain,
      parseFloat(formatEther(igpBalance)),
    );

    logger.info(
      {
        igpBalance: formatEther(igpBalance),
        claimThreshold: formatEther(claimThreshold),
      },
      'Checking IGP balance',
    );

    if (igpBalance > claimThreshold) {
      logger.info('IGP balance exceeds threshold, claiming');
      await this.multiProvider.sendTransaction(
        chain,
        await igpContract.populateTransaction.claim(),
      );
      logger.info('IGP claim completed');
    }
  }

  private async fundKeys(
    chain: string,
    keys: ResolvedKeyConfig[],
  ): Promise<void> {
    for (const key of keys) {
      await this.fundKey(chain, key);
    }
  }

  private async fundKey(chain: string, key: ResolvedKeyConfig): Promise<void> {
    const logger = this.options.logger.child({
      chain,
      address: key.address,
      role: key.role,
    });

    const desiredBalance = parseEther(key.desiredBalance);
    const fundingAmount = await this.calculateFundingAmount(
      chain,
      key.address,
      desiredBalance,
    );

    const currentBalance = toBigInt(
      await this.multiProvider.getProvider(chain).getBalance(key.address),
    );

    this.options.metrics?.recordWalletBalance(
      chain,
      key.address,
      key.role,
      parseFloat(formatEther(currentBalance)),
    );

    if (fundingAmount === 0n) {
      logger.debug(
        { currentBalance: formatEther(currentBalance) },
        'Key balance sufficient, skipping',
      );
      return;
    }

    const funderAddress = await this.multiProvider.getSignerAddress(chain);
    const funderBalance = toBigInt(
      await this.multiProvider.getSigner(chain).getBalance(),
    );

    if (funderBalance < fundingAmount) {
      logger.error(
        {
          funderBalance: formatEther(funderBalance),
          requiredAmount: formatEther(fundingAmount),
        },
        'Funder balance insufficient to cover funding amount',
      );
      throw new Error(
        `Insufficient funder balance on ${chain}: has ${formatEther(funderBalance)}, needs ${formatEther(fundingAmount)}`,
      );
    }

    logger.info(
      {
        amount: formatEther(fundingAmount),
        currentBalance: formatEther(currentBalance),
        desiredBalance: formatEther(desiredBalance),
        funderAddress,
        funderBalance: formatEther(funderBalance),
      },
      'Funding key',
    );

    const tx = await this.multiProvider.sendTransaction(chain, {
      to: key.address,
      value: fundingAmount,
    });

    this.options.metrics?.recordFundingAmount(
      chain,
      key.address,
      key.role,
      parseFloat(formatEther(fundingAmount)),
    );

    logger.info(
      {
        txHash: tx.transactionHash,
        txUrl: this.multiProvider.tryGetExplorerTxUrl(chain, {
          hash: tx.transactionHash,
        }),
      },
      'Funding transaction completed',
    );
  }

  private async calculateFundingAmount(
    chain: string,
    address: string,
    desiredBalance: bigint,
  ): Promise<bigint> {
    const currentBalance = toBigInt(
      await this.multiProvider.getProvider(chain).getBalance(address),
    );
    if (currentBalance >= desiredBalance) {
      return 0n;
    }
    const delta = desiredBalance - currentBalance;
    const minDelta =
      (desiredBalance * MIN_DELTA_NUMERATOR) / MIN_DELTA_DENOMINATOR;
    return delta > minDelta ? delta : 0n;
  }

  private async sweepExcessFunds(
    chain: string,
    chainConfig: ChainConfig,
  ): Promise<void> {
    const sweepConfig = chainConfig.sweep;
    if (!sweepConfig?.enabled) {
      return;
    }

    const logger = this.options.logger.child({ chain, operation: 'sweep' });

    if (!sweepConfig.address || !sweepConfig.threshold) {
      throw new Error(
        `Sweep config is invalid for chain ${chain}: address and threshold are required when sweep is enabled`,
      );
    }

    const threshold = parseEther(sweepConfig.threshold);
    const targetBalance = calculateMultipliedBalance(
      threshold,
      sweepConfig.targetMultiplier,
    );
    const triggerThreshold = calculateMultipliedBalance(
      threshold,
      sweepConfig.triggerMultiplier,
    );

    const funderBalance = toBigInt(
      await this.multiProvider.getSigner(chain).getBalance(),
    );

    logger.info(
      {
        funderBalance: formatEther(funderBalance),
        triggerThreshold: formatEther(triggerThreshold),
        targetBalance: formatEther(targetBalance),
      },
      'Checking sweep conditions',
    );

    if (funderBalance > triggerThreshold) {
      const sweepAmount = funderBalance - targetBalance;

      logger.info(
        {
          sweepAmount: formatEther(sweepAmount),
          sweepAddress: sweepConfig.address,
        },
        'Sweeping excess funds',
      );

      const tx = await this.multiProvider.sendTransaction(chain, {
        to: sweepConfig.address,
        value: sweepAmount,
      });

      this.options.metrics?.recordSweepAmount(
        chain,
        parseFloat(formatEther(sweepAmount)),
      );

      logger.info(
        {
          txHash: tx.transactionHash,
          txUrl: this.multiProvider.tryGetExplorerTxUrl(chain, {
            hash: tx.transactionHash,
          }),
        },
        'Sweep completed',
      );
    } else {
      logger.debug('Funder balance below trigger threshold, no sweep needed');
    }
  }
}

/**
 * Multiplies a BigNumber by a decimal multiplier with 2 decimal precision (floored).
 * e.g., 1 ETH * 1.555 = 1.55 ETH (not 1.56 ETH)
 */
export function calculateMultipliedBalance(
  base: bigint,
  multiplier: number,
): bigint {
  return (base * BigInt(Math.floor(multiplier * 100))) / 100n;
}

function toBigInt(value: bigint | number | string | { toString(): string }): bigint {
  return typeof value === 'bigint' ? value : BigInt(value.toString());
}

function createTimeoutPromise(
  timeoutMs: number,
  errorMessage: string,
): { promise: Promise<never>; cleanup: () => void } {
  let timeoutId: NodeJS.Timeout;
  const promise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });
  return {
    promise,
    cleanup: () => clearTimeout(timeoutId),
  };
}
