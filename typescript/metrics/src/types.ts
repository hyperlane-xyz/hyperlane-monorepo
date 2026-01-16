import type { ChainName, TokenStandard } from '@hyperlane-xyz/sdk';
import type { Address } from '@hyperlane-xyz/utils';

/**
 * xERC20 minting and burning limits for a token.
 */
export interface XERC20Limit {
  mint: number;
  burn: number;
  mintMax: number;
  burnMax: number;
}

/**
 * xERC20 information including limits and the xERC20 token address.
 */
export interface XERC20Info {
  limits: XERC20Limit;
  xERC20Address: Address;
}

/**
 * Balance information for a warp route token.
 */
export interface WarpRouteBalance {
  balance: number;
  valueUSD?: number;
  tokenAddress: Address;
}

/**
 * Native wallet balance information.
 */
export interface NativeWalletBalance {
  chain: ChainName;
  walletAddress: Address;
  walletName: string;
  balance: number;
}

/**
 * Token standards supported by warp metrics, including pseudo-standards.
 */
export type SupportedTokenStandards =
  | TokenStandard
  | 'EvmManagedLockbox'
  | 'xERC20';

/**
 * Base metric labels common to all warp route metrics.
 */
export interface BaseWarpRouteMetricLabels {
  chain_name: ChainName;
  token_address: string;
  token_name: string;
  warp_route_id: string;
}

/**
 * Full warp route metric labels including wallet and token standard info.
 */
export interface WarpRouteMetricLabels extends BaseWarpRouteMetricLabels {
  wallet_address: string;
  token_standard: SupportedTokenStandards;
  related_chain_names: string;
}

/**
 * Value at risk metric labels.
 */
export interface WarpRouteValueAtRiskMetricLabels
  extends BaseWarpRouteMetricLabels {
  collateral_chain_name: ChainName;
  collateral_token_standard: SupportedTokenStandards;
}
