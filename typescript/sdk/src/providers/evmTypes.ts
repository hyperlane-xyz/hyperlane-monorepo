export type EvmContractLike = { address?: string } & Record<string, unknown>;
export type EvmTransactionLike = {
  to?: string;
  data?: string;
  value?: unknown;
} & Record<string, unknown>;

export type EvmTransactionOverrides = Record<string, unknown>;

export type EvmGasAmount = bigint | { toString(): string };

export type EvmBlockLike = { number: number } & Record<string, unknown>;

export type EvmTransactionReceiptLike = {
  blockNumber?: number;
  transactionHash?: string;
  status?: number | string;
  logs?: unknown[];
} & Record<string, unknown>;

export type EvmTransactionResponseLike = {
  hash: string;
  data?: string;
  wait(confirmations?: number): Promise<EvmTransactionReceiptLike | null>;
} & Record<string, unknown>;

export interface EvmProviderLike {
  estimateGas(transaction: EvmTransactionLike): Promise<EvmGasAmount>;
  getBlock(blockTag: string | number): Promise<EvmBlockLike | null>;
  getBalance(address: string, blockTag?: string | number): Promise<unknown>;
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
  provider?: EvmProviderLike;
  connect(provider: EvmProviderLike): EvmSignerLike;
  getAddress(): Promise<string>;
  estimateGas(transaction: EvmTransactionLike): Promise<EvmGasAmount>;
  sendTransaction(
    transaction: EvmTransactionLike,
  ): Promise<EvmTransactionResponseLike>;
  getBalance(): Promise<unknown>;
}

export type EvmDeployTransactionLike = {
  data: string;
  hash?: string;
  wait?(confirmations?: number): Promise<EvmTransactionReceiptLike | null>;
} & Record<string, unknown>;

export type EvmDeployableContractLike = {
  address: string;
  deployTransaction?: EvmDeployTransactionLike;
} & Record<string, unknown>;
