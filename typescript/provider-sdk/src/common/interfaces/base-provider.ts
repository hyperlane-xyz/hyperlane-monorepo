export type ReqGetBalance = { address: string; denom?: string };

export type ReqGetTotalSupply = { denom?: string };

export type ReqEstimateTransactionFee<T> = {
  transaction: T;
  estimatedGasPrice?: string;
  senderAddress?: string;
  senderPubKey?: string;
};
export type ResEstimateTransactionFee = {
  gasUnits: bigint;
  gasPrice: number;
  fee: bigint;
};

export interface IBaseProvider<T = any> {
  // ### QUERY BASE ###

  isHealthy(): Promise<boolean>;

  getRpcUrls(): string[];

  getHeight(): Promise<number>;

  getBalance(req: ReqGetBalance): Promise<bigint>;

  getTotalSupply(req: ReqGetTotalSupply): Promise<bigint>;

  estimateTransactionFee(
    req: ReqEstimateTransactionFee<T>,
  ): Promise<ResEstimateTransactionFee>;
}
