import { ethers } from 'ethers';
import { formatUnits } from 'ethers/lib/utils.js';
import type { Logger } from 'pino';

import {
  HyperlaneIgp,
  IMultiProtocolSigner,
  MultiProtocolProvider,
  MultiProvider,
  PROTOCOL_TO_DEFAULT_PROVIDER_TYPE,
  ProtocolTypedTransaction,
  Token,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import type {
  ChainConfig,
  KeyFunderConfig,
  ResolvedKeyConfig,
} from '../config/types.js';
import type { KeyFunderMetrics } from '../metrics/Metrics.js';
import { normalizeKeyFunderProtocol } from '../utils.js';

const MIN_DELTA_NUMERATOR = 6n;
const MIN_DELTA_DENOMINATOR = 10n;

const CHAIN_FUNDING_TIMEOUT_MS = 60_000;

export interface KeyFunderOptions {
  logger: Logger;
  metrics?: KeyFunderMetrics;
  skipIgpClaim?: boolean;
  igp?: HyperlaneIgp;
  getSigner: (chain: string) => Promise<IMultiProtocolSigner<ProtocolType>>;
}

export class KeyFunder {
  constructor(
    private readonly multiProvider: MultiProvider,
    private readonly multiProtocolProvider: MultiProtocolProvider,
    private readonly config: KeyFunderConfig,
    private readonly options: KeyFunderOptions,
  ) {}

  async fundAllChains(): Promise<void> {
    const chainsToSkip = new Set(this.config.chainsToSkip ?? []);
    const chains = Object.keys(this.config.chains).filter(
      (chain) => !chainsToSkip.has(chain),
    );

    const results = await Promise.allSettled(
      chains.map(async (chain) => this.fundChainWithTimeout(chain)),
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
    if (!Object.prototype.hasOwnProperty.call(this.config.chains, chain)) {
      this.options.logger.warn({ chain }, 'No config for chain, skipping');
      return;
    }
    const chainConfig = this.config.chains[chain];

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
    const funderAddress = await this.getFunderAddress(chain);
    const funderBalance = await this.getNativeBalance(chain, funderAddress);
    const balanceInNativeToken = parseFloat(
      this.formatNativeAmount(chain, funderBalance),
    );
    this.options.metrics?.recordUnifiedWalletBalance(
      chain,
      funderAddress,
      'key-funder',
      balanceInNativeToken,
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
      if (!Object.prototype.hasOwnProperty.call(this.config.roles, roleName)) {
        this.options.logger.warn(
          { chain, role: roleName },
          'Role not found in config, skipping',
        );
        continue;
      }
      const roleConfig = this.config.roles[roleName];

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
    const igpBalance = await provider.getBalance(igpContract.address);
    const claimThreshold = ethers.utils.parseEther(igpConfig.claimThreshold);

    this.options.metrics?.recordIgpBalance(
      chain,
      parseFloat(ethers.utils.formatEther(igpBalance)),
    );

    logger.info(
      {
        igpBalance: ethers.utils.formatEther(igpBalance),
        claimThreshold: ethers.utils.formatEther(claimThreshold),
      },
      'Checking IGP balance',
    );

    if (igpBalance.gt(claimThreshold)) {
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

    const desiredBalance = this.parseNativeAmount(chain, key.desiredBalance);
    const fundingAmount = await this.calculateFundingAmount(
      chain,
      key.address,
      desiredBalance,
    );

    const currentBalance = await this.getNativeBalance(chain, key.address);

    this.options.metrics?.recordWalletBalance(
      chain,
      key.address,
      key.role,
      parseFloat(this.formatNativeAmount(chain, currentBalance)),
    );

    if (fundingAmount === 0n) {
      logger.debug(
        { currentBalance: this.formatNativeAmount(chain, currentBalance) },
        'Key balance sufficient, skipping',
      );
      return;
    }

    const funderAddress = await this.getFunderAddress(chain);
    const funderBalance = await this.getNativeBalance(chain, funderAddress);

    if (funderBalance < fundingAmount) {
      logger.error(
        {
          funderBalance: this.formatNativeAmount(chain, funderBalance),
          requiredAmount: this.formatNativeAmount(chain, fundingAmount),
        },
        'Funder balance insufficient to cover funding amount',
      );
      throw new Error(
        `Insufficient funder balance on ${chain}: has ${this.formatNativeAmount(chain, funderBalance)}, needs ${this.formatNativeAmount(chain, fundingAmount)}`,
      );
    }

    logger.info(
      {
        amount: this.formatNativeAmount(chain, fundingAmount),
        currentBalance: this.formatNativeAmount(chain, currentBalance),
        desiredBalance: this.formatNativeAmount(chain, desiredBalance),
        funderAddress,
        funderBalance: this.formatNativeAmount(chain, funderBalance),
      },
      'Funding key',
    );

    const txHash = await this.sendNativeTransfer(chain, key.address, fundingAmount);

    this.options.metrics?.recordFundingAmount(
      chain,
      key.address,
      key.role,
      parseFloat(this.formatNativeAmount(chain, fundingAmount)),
    );

    logger.info(
      {
        txHash,
        txUrl: this.multiProtocolProvider.tryGetExplorerTxUrl(chain, {
          hash: txHash,
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
    const currentBalance = await this.getNativeBalance(chain, address);
    if (currentBalance >= desiredBalance) {
      return 0n;
    }
    const delta = desiredBalance - currentBalance;
    const minDelta = (desiredBalance * MIN_DELTA_NUMERATOR) / MIN_DELTA_DENOMINATOR;
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

    const threshold = this.parseNativeAmount(chain, sweepConfig.threshold);
    const targetBalance = calculateMultipliedBalance(
      threshold,
      sweepConfig.targetMultiplier,
    );
    const triggerThreshold = calculateMultipliedBalance(
      threshold,
      sweepConfig.triggerMultiplier,
    );

    const funderAddress = await this.getFunderAddress(chain);
    const funderBalance = await this.getNativeBalance(chain, funderAddress);

    logger.info(
      {
        funderBalance: this.formatNativeAmount(chain, funderBalance),
        triggerThreshold: this.formatNativeAmount(chain, triggerThreshold),
        targetBalance: this.formatNativeAmount(chain, targetBalance),
      },
      'Checking sweep conditions',
    );

    if (funderBalance > triggerThreshold) {
      const sweepAmount = funderBalance - targetBalance;

      logger.info(
        {
          sweepAmount: this.formatNativeAmount(chain, sweepAmount),
          sweepAddress: sweepConfig.address,
        },
        'Sweeping excess funds',
      );

      const txHash = await this.sendNativeTransfer(
        chain,
        sweepConfig.address,
        sweepAmount,
      );

      this.options.metrics?.recordSweepAmount(
        chain,
        parseFloat(this.formatNativeAmount(chain, sweepAmount)),
      );

      logger.info(
        {
          txHash,
          txUrl: this.multiProtocolProvider.tryGetExplorerTxUrl(chain, {
            hash: txHash,
          }),
        },
        'Sweep completed',
      );
    } else {
      logger.debug('Funder balance below trigger threshold, no sweep needed');
    }
  }

  private getNativeToken(chain: string): Token {
    return Token.FromChainMetadataNativeToken(
      this.multiProtocolProvider.getChainMetadata(chain),
    );
  }

  private async getFunderAddress(chain: string): Promise<string> {
    const signer = await this.options.getSigner(chain);
    return signer.address();
  }

  private async getNativeBalance(chain: string, address: string): Promise<bigint> {
    return this.getNativeToken(chain)
      .getAdapter(this.multiProtocolProvider)
      .getBalance(address);
  }

  private parseNativeAmount(chain: string, amount: string): bigint {
    return BigInt(
      ethers.utils
        .parseUnits(amount, this.getNativeToken(chain).decimals)
        .toString(),
    );
  }

  private formatNativeAmount(chain: string, amount: bigint): string {
    return formatUnits(amount.toString(), this.getNativeToken(chain).decimals);
  }

  private async sendNativeTransfer(
    chain: string,
    recipient: string,
    amount: bigint,
  ): Promise<string> {
    const signer = await this.options.getSigner(chain);
    const fromAddress = await signer.address();
    const protocol = normalizeKeyFunderProtocol(
      this.multiProtocolProvider.getChainMetadata(chain).protocol,
    );
    const type = PROTOCOL_TO_DEFAULT_PROVIDER_TYPE[protocol];

    if (!type) {
      throw new Error(`Unsupported protocol ${protocol} for chain ${chain}`);
    }

    const transaction = await this.getNativeToken(chain)
      .getAdapter(this.multiProtocolProvider)
      .populateTransferTx({
        weiAmountOrId: amount,
        recipient,
        fromAccountOwner: fromAddress,
      });

    // CAST: `signer` and `type` are derived from the same normalized chain protocol above,
    // so the populated native transfer transaction matches the signer implementation.
    return signer.sendAndConfirmTransaction({
      transaction,
      type,
    } as ProtocolTypedTransaction<ProtocolType>);
  }
}

/**
 * Multiplies a native-token balance by a decimal multiplier with 2 decimal
 * precision (floored). e.g. 1 ETH * 1.555 = 1.55 ETH (not 1.56 ETH).
 */
export function calculateMultipliedBalance(
  base: bigint,
  multiplier: number,
): bigint {
  const [whole, fractional = ''] = multiplier.toString().split('.');
  const scaledMultiplier =
    BigInt(whole) * 100n + BigInt(fractional.padEnd(2, '0').slice(0, 2));
  return (base * scaledMultiplier) / 100n;
}

function createTimeoutPromise(
  timeoutMs: number,
  errorMessage: string,
): { promise: Promise<never>; cleanup: () => void } {
  let timeoutId: NodeJS.Timeout;
  const promise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(errorMessage));
    }, timeoutMs);
  });
  return {
    promise,
    cleanup: () => {
      clearTimeout(timeoutId);
    },
  };
}
