import { Address, Hex } from 'viem';

export type ViemTransactionRequestLike = {
  chainId?: number;
  data?: Hex;
  from?: Address | string;
  gas?: unknown;
  gasLimit?: unknown;
  gasPrice?: unknown;
  maxFeePerGas?: unknown;
  maxPriorityFeePerGas?: unknown;
  nonce?: number;
  to?: Address | string;
  type?: number | string;
  value?: unknown;
};

export type ViemProviderLike = {
  estimateGas(transaction: ViemTransactionRequestLike): Promise<unknown>;
  getFeeData(): Promise<{
    gasPrice?: unknown;
    maxFeePerGas?: unknown;
    maxPriorityFeePerGas?: unknown;
  }>;
  getNetwork(): Promise<{ chainId: number }>;
  getTransactionCount(
    address: Address | string,
    blockTag?: string,
  ): Promise<number>;
  sendTransaction(signedTransaction: Hex | string): Promise<{
    hash: string;
    wait(confirmations?: number): Promise<unknown>;
  }>;
};
