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
  EvmHypVSXERC20Adapter,
  EvmHypVSXERC20LockboxAdapter,
  EvmXERC20VSAdapter,
  IHypVSXERC20Adapter,
  MultiProtocolProvider,
  MultiProvider,
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfig,
  getSafe,
  getSafeDelegates,
  getSafeService,
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
    owner: expectedOwner,
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
        expectedOwner,
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
    rootLogger.info(
      chalk.yellow(`[${chain}][${bridgeAddress}] Nothing to update`),
    );
    return;
  }

  if (!dryRun) {
    await sendTransactions(
      envMultiProvider,
      chain,
      owner,
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
  proposer: Address,
  chain: string,
  multiProvider: MultiProvider,
  safeAddress: Address,
  bridgeAddress: Address,
): Promise<boolean> {
  // check if safe service is available
  await getSafeTxService(chain, multiProvider, bridgeAddress);

  try {
    await getSafe(chain, multiProvider, safeAddress);
    rootLogger.info(
      chalk.gray(`[${chain}][${bridgeAddress}] Safe found: ${safeAddress}`),
    );
    return true;
  } catch {
    rootLogger.info(
      chalk.gray(`[${chain}][${bridgeAddress}] Safe not found: ${safeAddress}`),
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
  const safeService = await getSafeTxService(
    chain,
    multiProvider,
    bridgeAddress,
  );
  // TODO: assumes the safeAddress is in fact a safe
  const safe = await getSafe(chain, multiProvider, safeAddress);

  const delegates = await getSafeDelegates(safeService, safeAddress);
  const owners = await safe.getOwners();

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

async function getSafeTxService(
  chain: string,
  multiProvider: MultiProvider,
  bridgeAddress: Address,
): Promise<any> {
  let safeService;
  try {
    safeService = getSafeService(chain, multiProvider);
  } catch (error) {
    rootLogger.error(
      chalk.red(
        `[${chain}][${bridgeAddress}] Safe service not available, cannot send safe transactions, please add the safe service url to registry and try again.`,
      ),
    );
    throw { chain, error };
  }
  return safeService;
}

async function sendAsSafeMultiSend(
  chain: string,
  safeAddress: Address,
  multiProvider: MultiProvider,
  transactions: PopulatedTransaction[],
  bridgeAddress: Address,
) {
  rootLogger.info(
    chalk.gray(
      `[${chain}][${bridgeAddress}] Using SafeMultiSend for ${transactions.length} transaction(s) to ${safeAddress}...`,
    ),
  );

  const multiSendTxs = getTxCallData(transactions);

  try {
    const safeMultiSend = new SafeMultiSend(multiProvider, chain, safeAddress);
    // TODO: SafeMultiSend.sendTransactions does not wait for the receipt
    await safeMultiSend.sendTransactions(multiSendTxs);
    rootLogger.info(
      chalk.green(
        `[${chain}][${bridgeAddress}] Safe multi-send transaction(s) submitted.`,
      ),
    );
  } catch (error) {
    rootLogger.error(
      chalk.red(
        `[${chain}][${bridgeAddress}] Error sending safe transactions:`,
        error,
      ),
    );
    throw { chain, error };
  }
}

async function sendAsSignerMultiSend(
  chain: string,
  multiProvider: MultiProvider,
  transactions: PopulatedTransaction[],
  bridgeAddress: Address,
) {
  rootLogger.info(
    chalk.gray(
      `[${chain}][${bridgeAddress}] Using SignerMultiSend for ${transactions.length} transaction(s)...`,
    ),
  );

  const multiSendTxs = getTxCallData(transactions);
  try {
    const signerMultiSend = new SignerMultiSend(multiProvider, chain);
    await signerMultiSend.sendTransactions(multiSendTxs);
    rootLogger.info(
      chalk.green(
        `[${chain}][${bridgeAddress}] Signer multi-send transaction(s) submitted.`,
      ),
    );
  } catch (error) {
    rootLogger.error(
      chalk.red(
        `[${chain}][${bridgeAddress}] Error sending signer transactions:`,
        error,
      ),
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
  expectedOwner: Address,
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
    signerAddress,
    chain,
    multiProvider,
    actualOwner,
    bridgeAddress,
  );

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
      throw new Error('Signer is not a safe proposer');
    }

    rootLogger.info(
      chalk.gray(`[${chain}][${bridgeAddress}] Sending as Safe transaction`),
    );
    await sendAsSafeMultiSend(
      chain,
      actualOwner,
      multiProvider,
      transactions,
      bridgeAddress,
    );
    return;
  }

  if (signerAddress !== actualOwner) {
    rootLogger.error(
      chalk.red(
        `[${chain}][${bridgeAddress}] Signer is not the owner of the xERC20 so cannot successful submit a Signer transaction. Exiting...`,
      ),
    );
    throw new Error('Signer is not the owner of the xERC20');
  }

  rootLogger.info(
    chalk.gray(`[${chain}][${bridgeAddress}] Sending as Signer transaction`),
  );
  await sendAsSignerMultiSend(
    chain,
    multiProvider,
    transactions,
    bridgeAddress,
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
