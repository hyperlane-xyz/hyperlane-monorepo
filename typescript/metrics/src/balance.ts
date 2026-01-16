import { Contract, type PopulatedTransaction } from 'ethers';
import type { Logger } from 'pino';

import { IXERC20VS__factory } from '@hyperlane-xyz/core';
import {
  type EvmHypXERC20Adapter,
  type EvmHypXERC20LockboxAdapter,
  EvmTokenAdapter,
  type IHypXERC20Adapter,
  type MultiProtocolProvider,
  type SealevelHypTokenAdapter,
  Token,
  TokenStandard,
  type WarpCore,
} from '@hyperlane-xyz/sdk';
import { type Address, ProtocolType } from '@hyperlane-xyz/utils';

import type {
  NativeWalletBalance,
  WarpRouteBalance,
  XERC20Info,
  XERC20Limit,
} from './types.js';
import { formatBigInt } from './utils.js';

/**
 * Minimal ABI for managed lockbox contracts.
 */
export const MANAGED_LOCKBOX_MINIMAL_ABI = [
  'function XERC20() view returns (address)',
  'function ERC20() view returns (address)',
] as const;

/**
 * Interface for token price getter to allow different implementations.
 */
export interface TokenPriceGetter {
  tryGetTokenPrice(token: Token): Promise<number | undefined>;
}

/**
 * Gets the bridged balance and value of a token in a warp route.
 *
 * @param warpCore - The WarpCore instance for the route
 * @param token - The token to get the balance for
 * @param tokenPriceGetter - Price getter for calculating USD value
 * @param logger - Logger instance
 * @param bridgedSupply - Optional pre-fetched bridged supply
 * @returns The balance information or undefined if not available
 */
export async function getTokenBridgedBalance(
  warpCore: WarpCore,
  token: Token,
  tokenPriceGetter: TokenPriceGetter,
  logger: Logger,
  bridgedSupply?: bigint,
): Promise<WarpRouteBalance | undefined> {
  if (!token.isHypToken()) {
    logger.warn(
      { token: token.symbol, chain: token.chainName },
      'No support for bridged balance on non-Hyperlane token',
    );
    return undefined;
  }

  const adapter = token.getHypAdapter(warpCore.multiProvider);
  let tokenAddress = token.collateralAddressOrDenom ?? token.addressOrDenom;

  // If bridged supply is not provided, fetch it
  const supply = bridgedSupply ?? (await adapter.getBridgedSupply());
  if (supply === undefined) {
    logger.warn(
      { token: token.symbol, chain: token.chainName },
      'Failed to get bridged supply',
    );
    return undefined;
  }

  const balance = token.amount(supply).getDecimalFormattedAmount();

  let tokenPrice;
  // Only record value for collateralized and xERC20 lockbox tokens.
  if (
    token.isCollateralized() ||
    token.standard === TokenStandard.EvmHypXERC20Lockbox ||
    token.standard === TokenStandard.EvmHypVSXERC20Lockbox
  ) {
    tokenPrice = await tokenPriceGetter.tryGetTokenPrice(token);
  }

  if (
    token.standard === TokenStandard.EvmHypXERC20Lockbox ||
    token.standard === TokenStandard.EvmHypVSXERC20Lockbox
  ) {
    tokenAddress = (await (adapter as EvmHypXERC20LockboxAdapter).getXERC20())
      .address;
  }

  return {
    balance,
    valueUSD: tokenPrice ? balance * tokenPrice : undefined,
    tokenAddress,
  };
}

/**
 * Gets the native balance of the ATA payer for Sealevel tokens.
 *
 * @param warpCore - The WarpCore instance for the route
 * @param token - The Sealevel token
 * @param warpRouteId - The warp route identifier
 * @returns The native wallet balance information
 */
export async function getSealevelAtaPayerBalance(
  warpCore: WarpCore,
  token: Token,
  warpRouteId: string,
): Promise<NativeWalletBalance> {
  if (token.protocol !== ProtocolType.Sealevel || token.isNative()) {
    throw new Error(
      `Unsupported ATA payer protocol type ${token.protocol} or standard ${token.standard}`,
    );
  }
  const adapter = token.getHypAdapter(
    warpCore.multiProvider,
  ) as SealevelHypTokenAdapter;

  const ataPayer = adapter.deriveAtaPayerAccount().toString();
  const nativeToken = Token.FromChainMetadataNativeToken(
    warpCore.multiProvider.getChainMetadata(token.chainName),
  );
  const ataPayerBalance = await nativeToken.getBalance(
    warpCore.multiProvider,
    ataPayer,
  );

  return {
    chain: token.chainName,
    walletAddress: ataPayer.toString(),
    walletName: `${warpRouteId}/ata-payer`,
    balance: ataPayerBalance.getDecimalFormattedAmount(),
  };
}

/**
 * Gets xERC20 information for a token.
 *
 * @param warpCore - The WarpCore instance for the route
 * @param token - The xERC20 token
 * @returns The xERC20 info including limits and address
 */
export async function getXERC20Info(
  warpCore: WarpCore,
  token: Token,
): Promise<XERC20Info> {
  if (token.protocol !== ProtocolType.Ethereum) {
    throw new Error(`Unsupported XERC20 protocol type ${token.protocol}`);
  }

  if (
    token.standard === TokenStandard.EvmHypXERC20 ||
    token.standard === TokenStandard.EvmHypVSXERC20
  ) {
    const adapter = token.getAdapter(
      warpCore.multiProvider,
    ) as EvmHypXERC20Adapter;
    return {
      limits: await getXERC20Limit(token, adapter),
      xERC20Address: (await adapter.getXERC20()).address,
    };
  } else if (
    token.standard === TokenStandard.EvmHypXERC20Lockbox ||
    token.standard === TokenStandard.EvmHypVSXERC20Lockbox
  ) {
    const adapter = token.getAdapter(
      warpCore.multiProvider,
    ) as EvmHypXERC20LockboxAdapter;
    return {
      limits: await getXERC20Limit(token, adapter),
      xERC20Address: (await adapter.getXERC20()).address,
    };
  }

  throw new Error(`Unsupported XERC20 token standard ${token.standard}`);
}

/**
 * Gets xERC20 limits from an adapter.
 *
 * @param token - The token to get limits for
 * @param xerc20 - The xERC20 adapter
 * @returns The xERC20 limits
 */
export async function getXERC20Limit(
  token: Token,
  xerc20: IHypXERC20Adapter<PopulatedTransaction>,
): Promise<XERC20Limit> {
  const [mintCurrent, mintMax, burnCurrent, burnMax] = await Promise.all([
    xerc20.getMintLimit(),
    xerc20.getMintMaxLimit(),
    xerc20.getBurnLimit(),
    xerc20.getBurnMaxLimit(),
  ]);

  return {
    mint: formatBigInt(token, mintCurrent),
    mintMax: formatBigInt(token, mintMax),
    burn: formatBigInt(token, burnCurrent),
    burnMax: formatBigInt(token, burnMax),
  };
}

/**
 * Gets a managed lockbox contract instance.
 *
 * @param multiProvider - The multi-protocol provider
 * @param chainName - The chain name
 * @param lockboxAddress - The lockbox contract address
 * @returns The Contract instance
 */
export function getManagedLockBox(
  multiProvider: MultiProtocolProvider,
  chainName: string,
  lockboxAddress: Address,
): Contract {
  const provider = multiProvider.getEthersV5Provider(chainName);
  return new Contract(lockboxAddress, MANAGED_LOCKBOX_MINIMAL_ABI, provider);
}

/**
 * Gets extra lockbox information for xERC20 tokens.
 *
 * @param multiProvider - The multi-protocol provider
 * @param warpToken - The warp token
 * @param lockboxAddress - The lockbox contract address
 * @returns The xERC20 info for the lockbox
 */
export async function getExtraLockboxInfo(
  multiProvider: MultiProtocolProvider,
  warpToken: Token,
  lockboxAddress: Address,
): Promise<XERC20Info> {
  const currentChainProvider = multiProvider.getEthersV5Provider(
    warpToken.chainName,
  );
  const lockboxInstance = getManagedLockBox(
    multiProvider,
    warpToken.chainName,
    lockboxAddress,
  );

  const xERC20Address = await lockboxInstance.XERC20();
  const vsXERC20Instance = IXERC20VS__factory.connect(
    xERC20Address,
    currentChainProvider,
  );

  const [mintMax, burnMax, mint, burn] = await Promise.all([
    vsXERC20Instance.mintingMaxLimitOf(lockboxAddress),
    vsXERC20Instance.burningMaxLimitOf(lockboxAddress),
    vsXERC20Instance.mintingCurrentLimitOf(lockboxAddress),
    vsXERC20Instance.burningCurrentLimitOf(lockboxAddress),
  ]);

  return {
    limits: {
      burn: formatBigInt(warpToken, burn.toBigInt()),
      burnMax: formatBigInt(warpToken, burnMax.toBigInt()),
      mint: formatBigInt(warpToken, mint.toBigInt()),
      mintMax: formatBigInt(warpToken, mintMax.toBigInt()),
    },
    xERC20Address,
  };
}

/**
 * Gets the balance of an extra lockbox.
 *
 * @param multiProvider - The multi-protocol provider
 * @param warpToken - The warp token
 * @param tokenPriceGetter - Price getter for calculating USD value
 * @param lockboxAddress - The lockbox contract address
 * @param logger - Logger instance
 * @returns The balance information or undefined if not available
 */
export async function getExtraLockboxBalance(
  multiProvider: MultiProtocolProvider,
  warpToken: Token,
  tokenPriceGetter: TokenPriceGetter,
  lockboxAddress: Address,
  logger: Logger,
): Promise<WarpRouteBalance | undefined> {
  if (!warpToken.isXerc20()) {
    return undefined;
  }

  const lockboxInstance = getManagedLockBox(
    multiProvider,
    warpToken.chainName,
    lockboxAddress,
  );

  const erc20TokenAddress = await lockboxInstance.ERC20();
  const erc20tokenAdapter = new EvmTokenAdapter(
    warpToken.chainName,
    multiProvider,
    {
      token: erc20TokenAddress,
    },
  );

  let balance;
  try {
    balance = await erc20tokenAdapter.getBalance(lockboxAddress);
  } catch (err) {
    logger.error(
      {
        err,
        chain: warpToken.chainName,
        token: warpToken.symbol,
        lockboxAddress,
        erc20TokenAddress,
      },
      'Failed to get balance for contract at lockbox address',
    );
    return undefined;
  }

  const tokenPrice = await tokenPriceGetter.tryGetTokenPrice(warpToken);
  const balanceNumber = formatBigInt(warpToken, balance);

  return {
    balance: balanceNumber,
    valueUSD: tokenPrice ? balanceNumber * tokenPrice : undefined,
    tokenAddress: erc20TokenAddress,
  };
}

/**
 * Gets collateral info for a managed lockbox.
 *
 * @param multiProvider - The multi-protocol provider
 * @param warpToken - The warp token
 * @param lockBoxAddress - The lockbox contract address
 * @returns The token name and address of the collateral
 */
export async function getManagedLockBoxCollateralInfo(
  multiProvider: MultiProtocolProvider,
  warpToken: Token,
  lockBoxAddress: Address,
): Promise<{ tokenName: string; tokenAddress: Address }> {
  const lockBoxInstance = getManagedLockBox(
    multiProvider,
    warpToken.chainName,
    lockBoxAddress,
  );

  const collateralTokenAddress = await lockBoxInstance.ERC20();
  const collateralTokenAdapter = new EvmTokenAdapter(
    warpToken.chainName,
    multiProvider,
    {
      token: collateralTokenAddress,
    },
  );

  const { name } = await collateralTokenAdapter.getMetadata();

  return {
    tokenName: name,
    tokenAddress: collateralTokenAddress,
  };
}
