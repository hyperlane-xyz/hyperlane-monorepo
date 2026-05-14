import { BigNumber, Contract, ethers } from 'ethers';
import type { ContractTransaction, Signer, providers } from 'ethers';
import type { Logger } from 'pino';

import { HyperlaneIgp, MultiProvider } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import type {
  ChainConfig,
  KeyFunderConfig,
  OpStackBridgeConfig,
  ResolvedKeyConfig,
} from '../config/types.js';
import type { KeyFunderMetrics } from '../metrics/Metrics.js';

const MIN_DELTA_NUMERATOR = BigNumber.from(6);
const MIN_DELTA_DENOMINATOR = BigNumber.from(10);

const CHAIN_FUNDING_TIMEOUT_MS = 60_000;
const OP_STACK_STANDARD_BRIDGE_ABI = [
  'function bridgeETHTo(address _to, uint32 _minGasLimit, bytes calldata _extraData) external payable',
];

type BridgeOverrides = Partial<providers.TransactionRequest> & {
  value: BigNumber;
};

interface OpStackStandardBridge {
  bridgeETHTo(
    to: string,
    minGasLimit: number,
    extraData: string,
    overrides: BridgeOverrides,
  ): Promise<ContractTransaction>;
}

export interface KeyFunderOptions {
  logger: Logger;
  metrics?: KeyFunderMetrics;
  skipIgpClaim?: boolean;
  igp?: HyperlaneIgp;
  opStackStandardBridgeFactory?: (
    standardBridge: string,
    signer: Signer,
  ) => OpStackStandardBridge;
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

    if (chainConfig.bridge) {
      await this.bridgeToOpStack(chain, chainConfig.bridge);
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

  private async bridgeToOpStack(
    chain: string,
    bridgeConfig: OpStackBridgeConfig,
  ): Promise<void> {
    const logger = this.options.logger.child({
      chain,
      operation: 'op-stack-bridge',
      parentChain: bridgeConfig.parentChain,
    });
    const childFunderAddress = await this.multiProvider.getSignerAddress(chain);
    const childFunderBalance = await this.multiProvider
      .getProvider(chain)
      .getBalance(childFunderAddress);
    const threshold = ethers.utils.parseEther(bridgeConfig.threshold);

    logger.info(
      {
        childFunderAddress,
        childFunderBalance: ethers.utils.formatEther(childFunderBalance),
        threshold: ethers.utils.formatEther(threshold),
      },
      'Checking OP Stack bridge conditions',
    );

    if (childFunderBalance.gte(threshold)) {
      logger.debug('Child funder balance sufficient, skipping bridge');
      return;
    }

    const targetBalance = ethers.utils.parseEther(bridgeConfig.targetBalance);
    const bridgeAmount = targetBalance.sub(childFunderBalance);
    const parentSigner = this.multiProvider.getSigner(bridgeConfig.parentChain);
    const parentFunderAddress = await parentSigner.getAddress();
    const parentFunderBalance = await parentSigner.getBalance();

    assert(
      parentFunderBalance.gte(bridgeAmount),
      `Insufficient parent funder balance on ${bridgeConfig.parentChain}: has ${ethers.utils.formatEther(parentFunderBalance)}, needs ${ethers.utils.formatEther(bridgeAmount)}`,
    );

    logger.info(
      {
        bridgeAmount: ethers.utils.formatEther(bridgeAmount),
        childFunderAddress,
        parentFunderAddress,
        parentFunderBalance: ethers.utils.formatEther(parentFunderBalance),
        standardBridge: bridgeConfig.standardBridge,
      },
      'Bridging native tokens to OP Stack chain',
    );

    const standardBridge = this.createOpStackStandardBridge(
      bridgeConfig.standardBridge,
      parentSigner,
    );
    const tx = standardBridge.bridgeETHTo(
      childFunderAddress,
      bridgeConfig.minGasLimit,
      '0x',
      {
        ...this.multiProvider.getTransactionOverrides(bridgeConfig.parentChain),
        value: bridgeAmount,
      },
    );
    const receipt = await this.multiProvider.handleTx(
      bridgeConfig.parentChain,
      tx,
    );

    logger.info(
      {
        txHash: receipt.transactionHash,
        txUrl: this.multiProvider.tryGetExplorerTxUrl(
          bridgeConfig.parentChain,
          { hash: receipt.transactionHash },
        ),
      },
      'OP Stack bridge transaction completed',
    );
  }

  private createOpStackStandardBridge(
    standardBridge: string,
    signer: Signer,
  ): OpStackStandardBridge {
    return (
      this.options.opStackStandardBridgeFactory ??
      ((address: string, contractSigner: Signer) =>
        new Contract(
          address,
          OP_STACK_STANDARD_BRIDGE_ABI,
          contractSigner,
        ) as unknown as OpStackStandardBridge)
    )(standardBridge, signer);
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

    const desiredBalance = ethers.utils.parseEther(key.desiredBalance);
    const fundingAmount = await this.calculateFundingAmount(
      chain,
      key.address,
      desiredBalance,
    );

    const currentBalance = await this.multiProvider
      .getProvider(chain)
      .getBalance(key.address);

    this.options.metrics?.recordWalletBalance(
      chain,
      key.address,
      key.role,
      parseFloat(ethers.utils.formatEther(currentBalance)),
    );

    if (fundingAmount.eq(0)) {
      logger.debug(
        { currentBalance: ethers.utils.formatEther(currentBalance) },
        'Key balance sufficient, skipping',
      );
      return;
    }

    const funderAddress = await this.multiProvider.getSignerAddress(chain);
    const funderBalance = await this.multiProvider
      .getSigner(chain)
      .getBalance();

    if (funderBalance.lt(fundingAmount)) {
      logger.error(
        {
          funderBalance: ethers.utils.formatEther(funderBalance),
          requiredAmount: ethers.utils.formatEther(fundingAmount),
        },
        'Funder balance insufficient to cover funding amount',
      );
      throw new Error(
        `Insufficient funder balance on ${chain}: has ${ethers.utils.formatEther(funderBalance)}, needs ${ethers.utils.formatEther(fundingAmount)}`,
      );
    }

    logger.info(
      {
        amount: ethers.utils.formatEther(fundingAmount),
        currentBalance: ethers.utils.formatEther(currentBalance),
        desiredBalance: ethers.utils.formatEther(desiredBalance),
        funderAddress,
        funderBalance: ethers.utils.formatEther(funderBalance),
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
      parseFloat(ethers.utils.formatEther(fundingAmount)),
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
    desiredBalance: BigNumber,
  ): Promise<BigNumber> {
    const currentBalance = await this.multiProvider
      .getProvider(chain)
      .getBalance(address);
    if (currentBalance.gte(desiredBalance)) {
      return BigNumber.from(0);
    }
    const delta = desiredBalance.sub(currentBalance);
    const minDelta = desiredBalance
      .mul(MIN_DELTA_NUMERATOR)
      .div(MIN_DELTA_DENOMINATOR);
    return delta.gt(minDelta) ? delta : BigNumber.from(0);
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

    const threshold = ethers.utils.parseEther(sweepConfig.threshold);
    const targetBalance = calculateMultipliedBalance(
      threshold,
      sweepConfig.targetMultiplier,
    );
    const triggerThreshold = calculateMultipliedBalance(
      threshold,
      sweepConfig.triggerMultiplier,
    );

    const funderBalance = await this.multiProvider
      .getSigner(chain)
      .getBalance();

    logger.info(
      {
        funderBalance: ethers.utils.formatEther(funderBalance),
        triggerThreshold: ethers.utils.formatEther(triggerThreshold),
        targetBalance: ethers.utils.formatEther(targetBalance),
      },
      'Checking sweep conditions',
    );

    if (funderBalance.gt(triggerThreshold)) {
      const sweepAmount = funderBalance.sub(targetBalance);

      logger.info(
        {
          sweepAmount: ethers.utils.formatEther(sweepAmount),
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
        parseFloat(ethers.utils.formatEther(sweepAmount)),
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
  base: BigNumber,
  multiplier: number,
): BigNumber {
  return base.mul(Math.floor(multiplier * 100)).div(100);
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
