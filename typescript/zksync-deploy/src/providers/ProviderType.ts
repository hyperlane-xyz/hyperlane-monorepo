import type {
  Contract as zksynceraEV5Contract,
  Provider as zksynceraEV5Providers,
  TransactionRequest as zksynceraEV5Transaction,
} from 'zksync-ethers';

export enum ProviderType {
  zksynceraEthersV5 = 'zksynceraethers-v5',
}

export type ProviderMap<Value> = Partial<Record<ProviderType, Value>>;

/**
 * Providers with discriminated union of type
 */

interface TypedProviderBase<T> {
  type: ProviderType;
  provider: T;
}

export interface zksynceraEthersV5Provider
  extends TypedProviderBase<zksynceraEV5Providers> {
  type: ProviderType.zksynceraEthersV5;
  provider: zksynceraEV5Providers;
}

export type TypedProvider = zksynceraEthersV5Provider;

/**
 * Contracts with discriminated union of provider type
 */

interface TypedContractBase<T> {
  type: ProviderType;
  contract: T;
}

export interface EthersV5Contract
  extends TypedContractBase<zksynceraEV5Contract> {
  type: ProviderType.zksynceraEthersV5;
  contract: zksynceraEV5Contract;
}

export type TypedContract = zksynceraEV5Contract;

/**
 * Transactions with discriminated union of provider type
 */

interface TypedTransactionBase<T> {
  type: ProviderType;
  transaction: T;
}

export interface zksynceraEthersV5Transaction
  extends TypedTransactionBase<zksynceraEV5Transaction> {
  type: ProviderType.zksynceraEthersV5;
  transaction: zksynceraEV5Transaction;
}

export type TypedTransaction = zksynceraEthersV5Transaction;

/**
 * Transaction receipt/response with discriminated union of provider type
 */

interface TypedTransactionReceiptBase<T> {
  type: ProviderType;
  receipt: T;
}

export interface zksynceraEthersV5TransactionReceipt
  extends TypedTransactionReceiptBase<zksynceraEV5Providers.TransactionReceipt> {
  type: ProviderType.zksynceraEthersV5;
  receipt: zksynceraEV5Providers.TransactionReceipt;
}

export type TypedTransactionReceipt = zksynceraEthersV5TransactionReceipt;
