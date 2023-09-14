import type {
  Connection,
  Transaction as SolTransaction,
  VersionedTransactionResponse as SolTransactionReceipt,
} from '@solana/web3.js';
import type {
  Contract as EV5Contract,
  providers as EV5Providers,
  PopulatedTransaction as EV5Transaction,
} from 'ethers';
// import type { Contract as Ev6Contract, Provider as Ev6Provider } from 'ethers6';
import type {
  GetContractReturnType,
  PublicClient,
  Transaction as VTransaction,
  TransactionReceipt as VTransactionReceipt,
} from 'viem';

export enum ProviderType {
  EthersV5 = 'ethers-v5',
  // EthersV6 = 'ethers-v6', Disabled for now to simplify build tooling
  Viem = 'viem',
  SolanaWeb3 = 'solana-web3',
}

export type ProviderMap<Value> = Partial<Record<ProviderType, Value>>;

/**
 * Providers with discriminated union of type
 */

interface TypedProviderBase<T> {
  type: ProviderType;
  provider: T;
}

export interface EthersV5Provider
  extends TypedProviderBase<EV5Providers.Provider> {
  type: ProviderType.EthersV5;
  provider: EV5Providers.Provider;
}

// export interface EthersV6Provider extends TypedProviderBase<Ev6Provider> {
//   type: ProviderType.EthersV6;
//   provider: Ev6Provider;
// }

export interface ViemProvider extends TypedProviderBase<PublicClient> {
  type: ProviderType.Viem;
  provider: PublicClient;
}

export interface SolanaWeb3Provider extends TypedProviderBase<Connection> {
  type: ProviderType.SolanaWeb3;
  provider: Connection;
}

export type TypedProvider =
  | EthersV5Provider
  // | EthersV6Provider
  | ViemProvider
  | SolanaWeb3Provider;

/**
 * Contracts with discriminated union of provider type
 */

interface TypedContractBase<T> {
  type: ProviderType;
  contract: T;
}

export interface EthersV5Contract extends TypedContractBase<EV5Contract> {
  type: ProviderType.EthersV5;
  transaction: EV5Contract;
}

// export interface EthersV6Contract extends TypedContractBase<Ev6Contract> {
//   type: ProviderType.EthersV6;
//   contract: Ev6Contract;
// }

export interface ViemContract extends TypedContractBase<GetContractReturnType> {
  type: ProviderType.Viem;
  transaction: GetContractReturnType;
}

export interface SolanaWeb3Contract extends TypedContractBase<never> {
  type: ProviderType.SolanaWeb3;
  // Contract concept doesn't exist in @solana/web3.js
  transaction: never;
}

export type TypedContract =
  | EthersV5Contract
  // | EthersV6Contract
  | ViemContract
  | SolanaWeb3Contract;

/**
 * Transactions with discriminated union of provider type
 */

interface TypedTransactionBase<T> {
  type: ProviderType;
  transaction: T;
}

export interface EthersV5Transaction
  extends TypedTransactionBase<EV5Transaction> {
  type: ProviderType.EthersV5;
  transaction: EV5Transaction;
}

// export interface EthersV6Transaction extends TypedTransactionBase<Ev6Transaction> {
//   type: ProviderType.EthersV6;
//   contract: Ev6Transaction;
// }

export interface ViemTransaction extends TypedTransactionBase<VTransaction> {
  type: ProviderType.Viem;
  transaction: VTransaction;
}

export interface SolanaWeb3Transaction
  extends TypedTransactionBase<SolTransaction> {
  type: ProviderType.SolanaWeb3;
  transaction: SolTransaction;
}

export type TypedTransaction =
  | EthersV5Transaction
  // | EthersV6Transaction
  | ViemTransaction
  | SolanaWeb3Transaction;

/**
 * Transaction receipt/response with discriminated union of provider type
 */

interface TypedTransactionReceiptBase<T> {
  type: ProviderType;
  receipt: T;
}

export interface EthersV5TransactionReceipt
  extends TypedTransactionReceiptBase<EV5Providers.TransactionReceipt> {
  type: ProviderType.EthersV5;
  receipt: EV5Providers.TransactionReceipt;
}

export interface ViemTransactionReceipt
  extends TypedTransactionReceiptBase<VTransactionReceipt> {
  type: ProviderType.Viem;
  receipt: VTransactionReceipt;
}

export interface SolanaWeb3TransactionReceipt
  extends TypedTransactionReceiptBase<SolTransactionReceipt> {
  type: ProviderType.SolanaWeb3;
  receipt: SolTransactionReceipt;
}

export type TypedTransactionReceipt =
  | EthersV5TransactionReceipt
  | ViemTransactionReceipt
  | SolanaWeb3TransactionReceipt;
