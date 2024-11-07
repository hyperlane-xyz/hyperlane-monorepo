export interface xERC20Limit {
  tokenName: string;
  mint: number;
  burn: number;
  mintMax: number;
  burnMax: number;
}

export interface WarpRouteInfo {
  balance: number;
  valueUSD?: number;
}
