import { BigNumber } from 'bignumber.js';
import chalk from 'chalk';
import { PopulatedTransaction } from 'ethers';
import { join } from 'path';

import {
  HypXERC20Lockbox__factory,
  Ownable__factory,
} from '@hyperlane-xyz/core';
import {
  ChainName,
  EvmXERC20VSAdapter,
  MultiProtocolProvider,
  MultiProvider,
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfig,
  isXERC20TokenConfig,
} from '@hyperlane-xyz/sdk';
import { Address, CallData, rootLogger } from '@hyperlane-xyz/utils';

import { getRegistry } from '../../config/registry.js';
import {
  ManualMultiSend,
  MultiSend,
  SafeMultiSend,
  SignerMultiSend,
} from '../govern/multisend.js';
import { getSafeAndService } from '../utils/safe.js';
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
    decimals,
  } = bridgeConfig;

  if (bufferCap === 0 && rateLimitPerSecond === 0) {
    rootLogger.warn(
      chalk.yellow(
        `[${chain}][${bridgeAddress}] Skipping addBridge as buffer cap and rate limit are both 0.`,
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
          `[${chain}][${bridgeAddress}] Skipping addBridge as rate limits set already.`,
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
        `[${chain}][${bridgeAddress}] Preparing to add bridge to ${xERC20Address}`,
      ),
    );
    rootLogger.info(
      chalk.gray(
        `[${chain}][${bridgeAddress}] Buffer cap: ${humanReadableLimit(
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
          `[${chain}][${bridgeAddress}] Sending addBridge transaction to ${xERC20Address}...`,
        ),
      );
      await sendTransactions(
        envMultiProvider,
        chain,
        [tx],
        xERC20Address,
        bridgeAddress,
      );
    } else {
      rootLogger.info(
        chalk.gray(
          `[${chain}][${bridgeAddress}] Dry run, no transactions sent, exiting...`,
        ),
      );
    }
  } catch (error) {
    rootLogger.error(
      chalk.red(`[${chain}][${bridgeAddress}] Error adding bridge:`, error),
    );
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

  // if buffer cap is 0, remove the bridge
  if (bufferCap === 0) {
    // return if the bridge is already removed
    if (currentBufferCap === BigInt(0)) {
      rootLogger.info(
        chalk.yellow(`[${chain}][${bridgeAddress}] Bridge already removed`),
      );
      return;
    }

    const removeBridgeTx = await prepareRemoveBridgeTx(
      chain,
      xERC20Adapter,
      bridgeAddress,
    );

    if (dryRun) {
      rootLogger.info(
        chalk.gray(
          `[${chain}][${bridgeAddress}] Dry run, no transactions sent, exiting...`,
        ),
      );
      return;
    }

    await sendTransactions(
      envMultiProvider,
      chain,
      [removeBridgeTx],
      xERC20Address,
      bridgeAddress,
    );

    return;
  }

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
    rootLogger.info(
      chalk.blue(`[${chain}][${bridgeAddress}] Nothing to update`),
    );
    return;
  }

  if (!dryRun) {
    await sendTransactions(
      envMultiProvider,
      chain,
      txsToSend,
      xERC20Address,
      bridgeAddress,
    );
  } else {
    rootLogger.info(
      chalk.gray(
        `[${chain}][${bridgeAddress}] Dry run, no transactions sent, exiting...`,
      ),
    );
  }
}

// Remove bridge
async function prepareRemoveBridgeTx(
  chain: string,
  adapter: EvmXERC20VSAdapter,
  bridgeAddress: Address,
): Promise<PopulatedTransaction> {
  rootLogger.info(
    chalk.gray(
      `[${chain}][${bridgeAddress}] Preparing to remove bridge from ${adapter.addresses.token}`,
    ),
  );
  return adapter.populateRemoveBridgeTx(bridgeAddress);
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
      chalk.green(
        `[${chain}][${bridgeAddress}] Buffer cap is already set to the desired value`,
      ),
    );
    return null;
  }

  rootLogger.info(
    chalk.gray(
      `[${chain}][${bridgeAddress}] Preparing buffer cap update: ${humanReadableLimit(
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
        `[${chain}][${bridgeAddress}] Rate limit per second is already set to the desired value`,
      ),
    );
    return null;
  }

  rootLogger.info(
    chalk.gray(
      `[${chain}][${bridgeAddress}] Preparing rate limit update: ${humanReadableLimit(
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

async function checkOwnerIsSafe(
  chain: string,
  multiProvider: MultiProvider,
  owner: Address,
  bridgeAddress: Address,
): Promise<boolean> {
  try {
    await getSafeAndService(chain, multiProvider, owner);
    rootLogger.debug(
      chalk.gray(`[${chain}][${bridgeAddress}] Safe found: ${owner}`),
    );
    return true;
  } catch (error) {
    const level =
      error instanceof Error &&
      error.message.includes('must provide tx service url')
        ? 'warn'
        : 'info';
    const color = level === 'warn' ? chalk.yellow : chalk.gray;
    rootLogger[level](
      color(`[${chain}][${bridgeAddress}] Safe not found: ${owner}. ${error}`),
    );
    return false;
  }
}

async function checkSafeProposer(
  proposer: Address,
  chain: string,
  multiProvider: MultiProvider,
  safeAddress: Address,
  bridgeAddress: Address,
): Promise<boolean> {
  const { safeSdk, safeService } = await getSafeAndService(
    chain,
    multiProvider,
    safeAddress,
  );

  const delegates = await safeService
    .getSafeDelegates({ safeAddress })
    .then((r) => r.results.map((r) => r.delegate));
  const owners = await safeSdk.getOwners();

  const isSafeProposer =
    delegates.includes(proposer) || owners.includes(proposer);

  if (isSafeProposer) {
    rootLogger.info(
      chalk.gray(
        `[${chain}][${bridgeAddress}] Safe proposer detected: ${proposer}`,
      ),
    );
    return true;
  } else {
    rootLogger.info(
      chalk.gray(
        `[${chain}][${bridgeAddress}] Safe proposer not detected: ${proposer}`,
      ),
    );
    return false;
  }
}

async function sendAsMultiSend(
  chain: string,
  transactions: PopulatedTransaction[],
  bridgeAddress: Address,
  multiSend: MultiSend,
  safeAddress?: Address,
) {
  const targetAddress = safeAddress ? ` to ${safeAddress}` : '';
  rootLogger.info(
    chalk.gray(
      `[${chain}][${bridgeAddress}] Using ${multiSend.constructor.name}MultiSend for ${transactions.length} transaction(s)${targetAddress}...`,
    ),
  );

  const multiSendTxs = getTxCallData(transactions);
  try {
    await multiSend.sendTransactions(multiSendTxs);
    rootLogger.info(
      chalk.green(
        `[${chain}][${bridgeAddress}] ${multiSend.constructor.name} multi-send transaction(s) submitted.`,
      ),
    );
  } catch (error) {
    rootLogger.error(
      chalk.red(
        `[${chain}][${bridgeAddress}] Error sending ${multiSend.constructor.name} transactions:`,
        error,
      ),
    );

    // if the multi-send fails, fallback to manual mode
    rootLogger.info(
      chalk.gray(`[${chain}][${bridgeAddress}] Falling back to manual mode.`),
    );
    const manualMultiSend = new ManualMultiSend(chain);
    await manualMultiSend.sendTransactions(multiSendTxs);

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
  transactions: PopulatedTransaction[],
  xERC20Address: Address,
  bridgeAddress: Address,
): Promise<void> {
  // function aims to successfully submit a transaction for the following scenarios:
  // 1. (initial deployment before ownership transfer) xERC20 is owned by an EOA (deployer), the expected owner (safe) is NOT the actual owner (deployer), the configured signer (deployer) is the owner (deployer) -> send normal transaction
  // 2. xERC20 is owned by an EOA (deployer), the expected owner (deployer) is the actual owner (deployer) and the configured signer (deployer) is the owner (deployer) -> send normal transaction
  // 3. xERC20 is owned by a Safe, the expected owner (safe) is the actual owner (safe), the configured signer (deployer) has the ability to propose safe transactions -> propose a safe transaction

  const signer = multiProvider.getSigner(chain);
  const signerAddress = await signer.getAddress();
  const ownable = Ownable__factory.connect(xERC20Address, signer);
  const actualOwner = await ownable.owner();

  // only attempt to send as safe if
  // (a) the actual owner is a safe
  // (b) the signer (deployer) has the ability to propose transactions on the safe
  // otherwise fallback to a signer transaction, this fallback will allow for us to handle scenario 1 even though the expected owner is a safe
  const isOwnerSafe = await checkOwnerIsSafe(
    chain,
    multiProvider,
    actualOwner,
    bridgeAddress,
  );

  let sender: MultiSend | undefined;
  let safeAddress: Address | undefined;

  if (isOwnerSafe) {
    const isSafeProposer = await checkSafeProposer(
      signerAddress,
      chain,
      multiProvider,
      actualOwner,
      bridgeAddress,
    );
    if (!isSafeProposer) {
      rootLogger.error(
        chalk.red(
          `[${chain}][${bridgeAddress}] Signer ${signerAddress} is not a proposer on Safe (${actualOwner}), cannot submit safe transaction. Exiting...`,
        ),
      );
    } else {
      rootLogger.info(
        chalk.gray(`[${chain}][${bridgeAddress}] Sending as Safe transaction`),
      );
      sender = new SafeMultiSend(multiProvider, chain, actualOwner);
      safeAddress = actualOwner;
    }
  }

  if (signerAddress !== actualOwner) {
    rootLogger.warn(
      chalk.red(
        `[${chain}][${bridgeAddress}] Signer is not the owner of the xERC20 so cannot successful submit a Signer transaction.`,
      ),
    );
  } else {
    rootLogger.info(
      chalk.gray(`[${chain}][${bridgeAddress}] Sending as Signer transaction`),
    );
    sender = new SignerMultiSend(multiProvider, chain);
  }

  // have a ManualMultiSend as a fallback
  if (!sender) {
    rootLogger.info(
      chalk.gray(
        `[${chain}][${bridgeAddress}] No MultiSend configured, falling back to manual mode.`,
      ),
    );
    sender = new ManualMultiSend(chain);
  }

  await sendAsMultiSend(
    chain,
    transactions,
    bridgeAddress,
    sender,
    safeAddress,
  );
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

    if (xERC20.extraBridges) {
      for (const extraLockboxLimit of xERC20.extraBridges) {
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

export function getAndValidateBridgesToUpdate(
  chains: string[] | undefined,
  bridgesConfig: Record<string, BridgeConfig>,
): BridgeConfig[] {
  // if no chains are provided, return all configs
  if (!chains || chains.length === 0) {
    return Object.values(bridgesConfig);
  }

  // check that all provided chains are in the warp config
  // throw an error if any are not
  const configChains = Object.values(bridgesConfig).map(
    (config) => config.chain,
  );
  const nonConfigChains = chains.filter(
    (chain) => !configChains.includes(chain),
  );
  if (nonConfigChains.length > 0) {
    throw new Error(
      `The following chains are not in the provided warp config: ${nonConfigChains.join(
        ', ',
      )}`,
    );
  }

  // return only the configs that are in the chains array
  return Object.values(bridgesConfig).filter((config) =>
    chains.includes(config.chain),
  );
}
