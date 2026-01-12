import type { ChainName } from '@hyperlane-xyz/sdk';
import type { Address } from '@hyperlane-xyz/utils';

export interface XERC20Limit {
  mint: number;
  burn: number;
  mintMax: number;
  burnMax: number;
}

export interface WarpRouteBalance {
  balance: number;
  valueUSD?: number;
  tokenAddress: Address;
}

export interface NativeWalletBalance {
  chain: ChainName;
  walletAddress: Address;
  walletName: string;
  balance: number;
}

export interface WarpMonitorConfig {
  warpRouteId: string;
  checkFrequency: number;
  coingeckoApiKey?: string;
  registryUri?: string;
}
