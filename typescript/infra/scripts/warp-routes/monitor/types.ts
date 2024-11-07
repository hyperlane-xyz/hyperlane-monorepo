export interface XERC20Limit {
  tokenName: string;
  mint: number;
  burn: number;
  mintMax: number;
  burnMax: number;
}

export interface WarpRouteBalance {
  balance: number;
  valueUSD?: number;
}
