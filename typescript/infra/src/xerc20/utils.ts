import { BigNumber } from 'bignumber.js';
import chalk from 'chalk';
import { PopulatedTransaction } from 'ethers';
import { join } from 'path';

import { HypXERC20Lockbox__factory } from '@hyperlane-xyz/core';
import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  ChainName,
  EvmHypVSXERC20Adapter,
  EvmHypVSXERC20LockboxAdapter,
  EvmXERC20VSAdapter,
  IHypVSXERC20Adapter,
  MultiProtocolProvider,
  MultiProvider,
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfig,
  canProposeSafeTransactions,
  isXERC20TokenConfig,
} from '@hyperlane-xyz/sdk';
import { Address, CallData, rootLogger } from '@hyperlane-xyz/utils';

import { getRegistry } from '../../config/registry.js';
import { SafeMultiSend, SignerMultiSend } from '../govern/multisend.js';
import { getInfraPath } from '../utils/utils.js';

export const XERC20_BRIDGES_CONFIG_PATH = join(
  getInfraPath(),
  'scripts/xerc20/config.yaml',
);

export interface BridgeConfig {
  chain: string;
  type: TokenType.XERC20Lockbox | TokenType.XERC20;
  xERC20Address: Address;
  bridgeAddress: Address;
  decimals: number;
  owner: Address;
  bufferCap: number;
  rateLimitPerSecond: number;
}

export async function addBridgeToChain({
  chain,
  bridgeConfig,
  multiProtocolProvider,
  envMultiProvider,
  dryRun,
}: {
  chain: string;
  bridgeConfig: BridgeConfig;
  multiProtocolProvider: MultiProtocolProvider;
  envMultiProvider: MultiProvider;
  dryRun: boolean;
}) {
  const {
    xERC20Address,
    bridgeAddress,
    bufferCap,
    rateLimitPerSecond,
    owner,
    decimals,
  } = bridgeConfig;

  if (bufferCap === 0 && rateLimitPerSecond === 0) {
    rootLogger.warn(
      chalk.yellow(
        `[${chain}] Skipping addBridge as buffer cap and rate limit are both 0.`,
      ),
    );
    return;
  }

  const xERC20Adapter = new EvmXERC20VSAdapter(chain, multiProtocolProvider, {
    token: xERC20Address,
  });

  const bufferCapBigInt = BigInt(bufferCap);
  const rateLimitBigInt = BigInt(rateLimitPerSecond);

  try {
    const rateLimits = await xERC20Adapter.getRateLimits(bridgeAddress);
    if (rateLimits.rateLimitPerSecond) {
      rootLogger.warn(
        chalk.yellow(
          `[${chain}] Skipping addBridge as rate limits already set for bridge: ${bridgeAddress}.`,
        ),
      );
      return;
    }

    const tx = await xERC20Adapter.populateAddBridgeTx(
      bufferCapBigInt,
      rateLimitBigInt,
      bridgeAddress,
    );

    rootLogger.info(
      chalk.gray(
        `[${chain}] Preparing to add ${bridgeAddress} as bridge to ${xERC20Address}`,
      ),
    );
    rootLogger.info(
      chalk.gray(
        `[${chain}] Buffer cap: ${humanReadableLimit(
          BigInt(bufferCap),
          decimals,
        )}, Rate limit: ${humanReadableLimit(
          BigInt(rateLimitPerSecond),
          decimals,
        )}`,
      ),
    );

    if (!dryRun) {
      rootLogger.info(
        chalk.gray(
          `[${chain}] Sending addBridge transaction to ${xERC20Address}...`,
        ),
      );
      await sendTransactions(envMultiProvider, chain, owner, [tx]);
    } else {
      rootLogger.info(
        chalk.gray(`[${chain}] Dry run, no transactions sent, exiting...`),
      );
    }
  } catch (error) {
    rootLogger.error(chalk.red(`[${chain}] Error adding bridge:`, error));
    throw { chain, error };
  }
}

export async function updateChainLimits({
  chain,
  bridgeConfig,
  multiProtocolProvider,
  envMultiProvider,
  dryRun,
}: {
  chain: string;
  bridgeConfig: BridgeConfig;
  multiProtocolProvider: MultiProtocolProvider;
  envMultiProvider: MultiProvider;
  dryRun: boolean;
}) {
  const {
    bridgeAddress,
    owner,
    bufferCap,
    rateLimitPerSecond,
    decimals,
    xERC20Address,
  } = bridgeConfig;

  const xERC20Adapter = new EvmXERC20VSAdapter(chain, multiProtocolProvider, {
    token: xERC20Address,
  });

  const {
    rateLimitPerSecond: currentRateLimitPerSecond,
    bufferCap: currentBufferCap,
  } = await xERC20Adapter.getRateLimits(bridgeAddress);

  const bufferCapTx = await prepareBufferCapTx(
    chain,
    xERC20Adapter,
    bufferCap,
    currentBufferCap,
    decimals,
    bridgeAddress,
  );

  const rateLimitTx = await prepareRateLimitTx(
    chain,
    xERC20Adapter,
    rateLimitPerSecond,
    currentRateLimitPerSecond,
    decimals,
    bridgeAddress,
  );

  const txsToSend = [bufferCapTx, rateLimitTx].filter(
    Boolean,
  ) as PopulatedTransaction[];
  if (txsToSend.length === 0) {
    rootLogger.info(chalk.yellow(`[${chain}] Nothing to update`));
    return;
  }

  if (!dryRun) {
    await sendTransactions(envMultiProvider, chain, owner, txsToSend);
  } else {
    rootLogger.info(
      chalk.gray(`[${chain}] Dry run, no transactions sent, exiting...`),
    );
  }
}

async function prepareBufferCapTx(
  chain: string,
  adapter: EvmXERC20VSAdapter,
  newBufferCap: number,
  currentBufferCap: bigint,
  decimals: number,
  bridgeAddress: Address,
): Promise<PopulatedTransaction | null> {
  const newBufferCapBigInt = BigInt(newBufferCap);

  if (newBufferCapBigInt === currentBufferCap) {
    rootLogger.info(
      chalk.green(`[${chain}] Buffer cap is already set to the desired value`),
    );
    return null;
  }

  rootLogger.info(
    chalk.gray(
      `[${chain}] Preparing buffer cap update: ${humanReadableLimit(
        currentBufferCap,
        decimals,
      )} → ${humanReadableLimit(newBufferCapBigInt, decimals)}`,
    ),
  );
  return adapter.populateSetBufferCapTx(bridgeAddress, newBufferCapBigInt);
}

async function prepareRateLimitTx(
  chain: string,
  adapter: EvmXERC20VSAdapter,
  newRateLimitPerSecond: number,
  currentRateLimitPerSecond: bigint,
  decimals: number,
  bridgeAddress: Address,
): Promise<PopulatedTransaction | null> {
  const newRateLimitBigInt = BigInt(newRateLimitPerSecond);

  if (BigInt(newRateLimitBigInt) === currentRateLimitPerSecond) {
    rootLogger.info(
      chalk.green(
        `[${chain}] Rate limit per second is already set to the desired value`,
      ),
    );
    return null;
  }

  rootLogger.info(
    chalk.gray(
      `[${chain}] Preparing rate limit update: ${humanReadableLimit(
        currentRateLimitPerSecond,
        decimals,
      )} → ${humanReadableLimit(newRateLimitBigInt, decimals)}`,
    ),
  );
  return adapter.populateSetRateLimitPerSecondTx(
    bridgeAddress,
    newRateLimitBigInt,
  );
}

async function checkSafeOwner(
  proposer: Address,
  chain: string,
  multiProvider: MultiProvider,
  safeAddress: Address,
): Promise<boolean> {
  try {
    return await canProposeSafeTransactions(
      proposer,
      chain,
      multiProvider,
      safeAddress,
    );
  } catch {
    return false;
  }
}

async function sendAsSafeMultiSend(
  chain: string,
  safeAddress: Address,
  multiProvider: MultiProvider,
  transactions: PopulatedTransaction[],
) {
  rootLogger.info(
    chalk.gray(
      `[${chain}] Using SafeMultiSend for ${transactions.length} transaction(s) to ${safeAddress}...`,
    ),
  );

  const multiSendTxs = getTxCallData(transactions);

  try {
    const safeMultiSend = new SafeMultiSend(multiProvider, chain, safeAddress);

    await safeMultiSend.sendTransactions(multiSendTxs);
    rootLogger.info(
      chalk.green(`[${chain}] Safe multi-send transaction(s) submitted.`),
    );
  } catch (error) {
    rootLogger.error(
      chalk.red(`[${chain}] Error sending safe transactions:`, error),
    );
    throw { chain, error };
  }
}

async function sendAsSignerMultiSend(
  chain: string,
  multiProvider: MultiProvider,
  transactions: PopulatedTransaction[],
) {
  rootLogger.info(
    chalk.gray(
      `[${chain}] Using SignerMultiSend for ${transactions.length} transaction(s)...`,
    ),
  );

  const multiSendTxs = getTxCallData(transactions);
  try {
    const signerMultiSend = new SignerMultiSend(multiProvider, chain);
    await signerMultiSend.sendTransactions(multiSendTxs);
    rootLogger.info(
      chalk.green(`[${chain}] Signer multi-send transaction(s) submitted.`),
    );
  } catch (error) {
    rootLogger.error(
      chalk.red(`[${chain}] Error sending signer transactions:`, error),
    );
    throw { chain, error };
  }
}

function getTxCallData(transactions: PopulatedTransaction[]): CallData[] {
  return transactions.map((tx) => {
    if (!tx.to || !tx.data) {
      throw new Error('Populated transaction missing "to" or "data"');
    }
    return { to: tx.to, data: tx.data };
  });
}

async function sendTransactions(
  multiProvider: MultiProvider,
  chain: string,
  owner: Address,
  transactions: PopulatedTransaction[],
): Promise<void> {
  const signer = multiProvider.getSigner(chain);
  const proposerAddress = await signer.getAddress();
  const isSafeOwner = await checkSafeOwner(
    proposerAddress,
    chain,
    multiProvider,
    owner,
  );

  if (isSafeOwner) {
    await sendAsSafeMultiSend(chain, owner, multiProvider, transactions);
  } else {
    await sendAsSignerMultiSend(chain, multiProvider, transactions);
  }
}

export async function deriveBridgesConfig(
  warpDeployConfig: WarpRouteDeployConfig,
  warpCoreConfig: WarpCoreConfig,
  multiProvider: MultiProvider,
): Promise<Record<string, BridgeConfig>> {
  const bridgesConfig: Record<string, BridgeConfig> = {};

  for (const [chainName, chainConfig] of Object.entries(warpDeployConfig)) {
    if (!isXERC20TokenConfig(chainConfig)) {
      throw new Error(
        `Chain "${chainName}" is not an xERC20 compliant deployment`,
      );
    }

    const { token, type, owner, xERC20 } = chainConfig;

    const decimals = warpCoreConfig.tokens.find(
      (t) => t.chainName === chainName,
    )?.decimals;
    if (!decimals) {
      throw new Error(`Missing "decimals" for chain: ${chainName}`);
    }

    if (
      !xERC20 ||
      !xERC20.warpRouteLimits.bufferCap ||
      !xERC20.warpRouteLimits.rateLimitPerSecond
    ) {
      throw new Error(`Missing "limits" for chain: ${chainName}`);
    }

    let xERC20Address = token;
    const bridgeAddress = warpCoreConfig.tokens.find(
      (t) => t.chainName === chainName,
    )?.addressOrDenom;
    if (!bridgeAddress) {
      throw new Error(
        `Missing router address for chain ${chainName} and type ${type}`,
      );
    }

    const {
      bufferCap: bufferCapStr,
      rateLimitPerSecond: rateLimitPerSecondStr,
    } = xERC20.warpRouteLimits;
    const bufferCap = Number(bufferCapStr);
    const rateLimitPerSecond = Number(rateLimitPerSecondStr);

    if (type === TokenType.XERC20Lockbox) {
      const provider = multiProvider.getProvider(chainName);
      const hypXERC20Lockbox = HypXERC20Lockbox__factory.connect(
        bridgeAddress,
        provider,
      );

      xERC20Address = await hypXERC20Lockbox.xERC20();
    }

    if (xERC20.extraLockboxLimits) {
      for (const extraLockboxLimit of xERC20.extraLockboxLimits) {
        const { lockbox, limits } = extraLockboxLimit;
        const {
          bufferCap: extraBufferCap,
          rateLimitPerSecond: extraRateLimit,
        } = limits;

        if (!extraBufferCap || !extraRateLimit) {
          throw new Error(
            `Missing "bufferCap" or "rateLimitPerSecond" limits for extra lockbox: ${lockbox} on chain: ${chainName}`,
          );
        }

        bridgesConfig[lockbox] = {
          chain: chainName,
          type,
          xERC20Address,
          bridgeAddress: lockbox,
          owner,
          decimals,
          bufferCap: Number(extraBufferCap),
          rateLimitPerSecond: Number(extraRateLimit),
        };
      }
    }

    bridgesConfig[bridgeAddress] = {
      chain: chainName as ChainName,
      type,
      xERC20Address,
      bridgeAddress,
      owner,
      decimals,
      bufferCap,
      rateLimitPerSecond,
    };
  }

  return bridgesConfig;
}

export function getWarpConfigsAndArtifacts(warpRouteId: string): {
  warpDeployConfig: WarpRouteDeployConfig;
  warpCoreConfig: WarpCoreConfig;
} {
  const registry = getRegistry();
  const warpDeployConfig = registry.getWarpDeployConfig(warpRouteId);
  const warpCoreConfig = registry.getWarpRoute(warpRouteId);

  if (!warpDeployConfig) {
    throw new Error(`Warp deploy config for route ID ${warpRouteId} not found`);
  }
  if (!warpCoreConfig) {
    throw new Error(`Warp core config for route ID ${warpRouteId} not found`);
  }

  return { warpDeployConfig, warpCoreConfig };
}

function humanReadableLimit(limit: bigint, decimals: number): string {
  return new BigNumber(limit.toString())
    .dividedBy(new BigNumber(10).pow(decimals))
    .toString();
}

function getHypVSXERC20Adapter(
  chainName: ChainName,
  multiProtocolProvider: MultiProtocolProvider,
  addresses: { token: Address },
  isLockbox: boolean,
): IHypVSXERC20Adapter<PopulatedTransaction> {
  if (isLockbox) {
    return new EvmHypVSXERC20LockboxAdapter(
      chainName,
      multiProtocolProvider,
      addresses,
    );
  } else {
    return new EvmHypVSXERC20Adapter(
      chainName,
      multiProtocolProvider,
      addresses,
    );
  }
}
