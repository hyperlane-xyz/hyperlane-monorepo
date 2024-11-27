export interface XERC20Limit {
  mint: number;
  burn: number;
  mintMax: number;
  burnMax: number;
}

export interface WarpRouteBalance {
  balance: number;
  valueUSD?: number;
}

export interface NativeWalletBalance {
  chain: string;
  walletAddress: string;
  walletName: string;
  balance: number;
}
