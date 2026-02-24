export type EvmContractLike = {
  address?: string;
};

export type EvmTransactionLike = {
  to?: string;
  from?: string;
  data?: string;
  value?: EvmBigNumberish;
  gas?: EvmBigNumberish;
  gasLimit?: EvmBigNumberish;
  gasPrice?: EvmBigNumberish;
  maxFeePerGas?: EvmBigNumberish;
  maxPriorityFeePerGas?: EvmBigNumberish;
  nonce?: EvmBigNumberish;
  chainId?: EvmBigNumberish;
  type?: EvmBigNumberish;
  accessList?: readonly unknown[] | unknown[];
  customData?: Record<string, unknown>;
};

export type EvmTransactionOverrides = {
  from?: string;
  to?: string;
  data?: string;
  value?: EvmBigNumberish;
  gas?: EvmBigNumberish;
  gasLimit?: EvmBigNumberish;
  gasPrice?: EvmBigNumberish;
  maxFeePerGas?: EvmBigNumberish;
  maxPriorityFeePerGas?: EvmBigNumberish;
  nonce?: EvmBigNumberish;
  chainId?: EvmBigNumberish;
  type?: EvmBigNumberish;
  accessList?: readonly unknown[] | unknown[];
  customData?: Record<string, unknown>;
};

export type EvmBigNumberish = string | number | bigint | { toString(): string };
export type EvmGasAmount = EvmBigNumberish;

export type EvmBlockLike = {
  number: number;
};

export type EvmTransactionReceiptLike = {
  blockHash?: string | null;
  blockNumber?: EvmBigNumberish | null;
  contractAddress?: string | null;
  from?: string | null;
  to?: string | null;
  transactionHash?: string | null;
  transactionIndex?: EvmBigNumberish | null;
  status?: number | string;
  gasUsed?: EvmBigNumberish;
  cumulativeGasUsed?: EvmBigNumberish;
  logs?: readonly unknown[] | unknown[] | null;
};

export type EvmTransactionResponseLike = {
  hash: string;
  from?: string;
  to?: string;
  nonce?: EvmBigNumberish;
  gasPrice?: EvmBigNumberish;
  maxFeePerGas?: EvmBigNumberish;
  maxPriorityFeePerGas?: EvmBigNumberish;
  value?: EvmBigNumberish;
  data?: string;
  wait(confirmations?: number): Promise<EvmTransactionReceiptLike | null>;
};

export interface EvmProviderLike {
  estimateGas(transaction: EvmTransactionLike): Promise<EvmGasAmount>;
  getBlock(blockTag: string | number): Promise<EvmBlockLike | null>;
  getBalance(
    address: string,
    blockTag?: string | number,
  ): Promise<EvmBigNumberish>;
  getBlockNumber(): Promise<number>;
  getCode(
    address: string,
    blockTag?: string | number | bigint,
  ): Promise<string>;
  getStorageAt(
    address: string,
    position: string,
    blockTag?: string | number,
  ): Promise<string>;
  getLogs(filter: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  getFeeData(): Promise<Record<string, unknown>>;
  call(
    transaction: EvmTransactionLike,
    blockTag?: string | number,
  ): Promise<string>;
  getTransaction(
    hash: string,
  ): Promise<EvmTransactionResponseLike | Record<string, unknown> | null>;
  getTransactionCount(
    address: string,
    blockTag?: string | number,
  ): Promise<number>;
  getTransactionReceipt(
    hash: string,
  ): Promise<EvmTransactionReceiptLike | null>;
  send<T = unknown>(method: string, params: unknown[]): Promise<T>;
  getSigner(addressOrIndex?: string | number): EvmSignerLike;
}

export interface EvmSignerLike {
  provider?: unknown;
  connect(provider: unknown): EvmSignerLike;
  getAddress(): Promise<string>;
  estimateGas(transaction: EvmTransactionLike): Promise<EvmGasAmount>;
  sendTransaction(
    transaction: EvmTransactionLike,
  ): Promise<EvmTransactionResponseLike>;
  getBalance(): Promise<EvmBigNumberish>;
}

export type EvmDeployTransactionLike = {
  data: string;
  hash?: string;
  blockNumber?: number | bigint | string;
  transactionHash?: string;
  wait?(confirmations?: number): Promise<EvmTransactionReceiptLike | null>;
};

export type EvmDeployableContractLike = {
  address: string;
  deployTransaction?: EvmDeployTransactionLike;
};
