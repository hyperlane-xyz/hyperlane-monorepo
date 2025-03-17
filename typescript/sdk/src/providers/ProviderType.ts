import type {
  CosmWasmClient,
  Contract as CosmWasmContract,
  ExecuteInstruction,
} from '@cosmjs/cosmwasm-stargate';
import type { EncodeObject as CmTransaction } from '@cosmjs/proto-signing';
import type { DeliverTxResponse, StargateClient } from '@cosmjs/stargate';
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
import {
  Contract as StarknetContract,
  RpcProvider as StarknetProvider,
  ReceiptTx as StarknetReceiptTx,
  CallDetails as StarknetTransaction,
} from 'starknet';
import type {
  GetContractReturnType,
  PublicClient,
  Transaction as VTransaction,
  TransactionReceipt as VTransactionReceipt,
} from 'viem';

import { Annotated, ProtocolType } from '@hyperlane-xyz/utils';

export enum ProviderType {
  EthersV5 = 'ethers-v5',
  Viem = 'viem',
  SolanaWeb3 = 'solana-web3',
  CosmJs = 'cosmjs',
  CosmJsWasm = 'cosmjs-wasm',
  GnosisTxBuilder = 'gnosis-txBuilder',
  Starknet = 'starknet',
}

export const PROTOCOL_TO_DEFAULT_PROVIDER_TYPE: Record<
  ProtocolType,
  ProviderType
> = {
  [ProtocolType.Ethereum]: ProviderType.EthersV5,
  [ProtocolType.Sealevel]: ProviderType.SolanaWeb3,
  [ProtocolType.Cosmos]: ProviderType.CosmJsWasm,
  [ProtocolType.Starknet]: ProviderType.Starknet,
};

export type ProviderMap<Value> = Partial<Record<ProviderType, Value>>;

type ProtocolTypesMapping = {
  [ProtocolType.Ethereum]: {
    transaction: EthersV5Transaction;
    provider: EthersV5Provider;
    contract: EthersV5Contract;
    receipt: EthersV5TransactionReceipt;
  };
  [ProtocolType.Sealevel]: {
    transaction: SolanaWeb3Transaction;
    provider: SolanaWeb3Provider;
    contract: SolanaWeb3Contract;
    receipt: SolanaWeb3TransactionReceipt;
  };
  [ProtocolType.Cosmos]: {
    transaction: CosmJsWasmTransaction;
    provider: CosmJsWasmProvider;
    contract: CosmJsWasmContract;
    receipt: CosmJsWasmTransactionReceipt;
  };
  [ProtocolType.Starknet]: {
    transaction: StarknetJsTransaction;
    provider: StarknetJsProvider;
    contract: StarknetJsContract;
    receipt: StarknetJsTransactionReceipt;
  };
};

type ProtocolTyped<
  T extends ProtocolType,
  K extends keyof ProtocolTypesMapping[T],
> = ProtocolTypesMapping[T][K];

export type ProtocolTypedTransaction<T extends ProtocolType> = ProtocolTyped<
  T,
  'transaction'
>;
export type ProtocolTypedProvider<T extends ProtocolType> = ProtocolTyped<
  T,
  'provider'
>;
export type ProtocolTypedContract<T extends ProtocolType> = ProtocolTyped<
  T,
  'contract'
>;
export type ProtocolTypedReceipt<T extends ProtocolType> = ProtocolTyped<
  T,
  'receipt'
>;

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

export interface ViemProvider extends TypedProviderBase<PublicClient> {
  type: ProviderType.Viem;
  provider: PublicClient;
}

export interface SolanaWeb3Provider extends TypedProviderBase<Connection> {
  type: ProviderType.SolanaWeb3;
  provider: Connection;
}

export interface CosmJsProvider
  extends TypedProviderBase<Promise<StargateClient>> {
  type: ProviderType.CosmJs;
  provider: Promise<StargateClient>;
}

export interface CosmJsWasmProvider
  extends TypedProviderBase<Promise<CosmWasmClient>> {
  type: ProviderType.CosmJsWasm;
  provider: Promise<CosmWasmClient>;
}

export interface StarknetJsProvider
  extends TypedProviderBase<StarknetProvider> {
  type: ProviderType.Starknet;
  provider: StarknetProvider;
}

export type TypedProvider =
  | EthersV5Provider
  // | EthersV6Provider
  | ViemProvider
  | SolanaWeb3Provider
  | CosmJsProvider
  | CosmJsWasmProvider
  | StarknetJsProvider;

/**
 * Contracts with discriminated union of provider type
 */

interface TypedContractBase<T> {
  type: ProviderType;
  contract: T;
}

export interface EthersV5Contract extends TypedContractBase<EV5Contract> {
  type: ProviderType.EthersV5;
  contract: EV5Contract;
}

export interface ViemContract extends TypedContractBase<GetContractReturnType> {
  type: ProviderType.Viem;
  contract: GetContractReturnType;
}

export interface SolanaWeb3Contract extends TypedContractBase<never> {
  type: ProviderType.SolanaWeb3;
  // Contract concept doesn't exist in @solana/web3.js
  contract: never;
}

export interface CosmJsContract extends TypedContractBase<never> {
  type: ProviderType.CosmJs;
  // TODO, research if cosmos sdk modules have an equivalent for here
  contract: never;
}

export interface CosmJsWasmContract
  extends TypedContractBase<CosmWasmContract> {
  type: ProviderType.CosmJsWasm;
  contract: CosmWasmContract;
}

export interface StarknetJsContract
  extends TypedContractBase<StarknetContract> {
  type: ProviderType.Starknet;
  contract: StarknetContract;
}

export type TypedContract =
  | EthersV5Contract
  // | EthersV6Contract
  | ViemContract
  | SolanaWeb3Contract
  | CosmJsContract
  | CosmJsWasmContract
  | StarknetJsContract;

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

export type AnnotatedEV5Transaction = Annotated<EV5Transaction>;

export interface ViemTransaction extends TypedTransactionBase<VTransaction> {
  type: ProviderType.Viem;
  transaction: VTransaction;
}

export interface SolanaWeb3Transaction
  extends TypedTransactionBase<SolTransaction> {
  type: ProviderType.SolanaWeb3;
  transaction: SolTransaction;
}

export interface CosmJsTransaction extends TypedTransactionBase<CmTransaction> {
  type: ProviderType.CosmJs;
  transaction: CmTransaction;
}

export interface CosmJsWasmTransaction
  extends TypedTransactionBase<ExecuteInstruction> {
  type: ProviderType.CosmJsWasm;
  transaction: ExecuteInstruction;
}

export interface StarknetJsTransaction
  extends TypedTransactionBase<StarknetTransaction> {
  type: ProviderType.Starknet;
  transaction: StarknetTransaction;
}

export type TypedTransaction =
  | EthersV5Transaction
  // | EthersV6Transaction
  | ViemTransaction
  | SolanaWeb3Transaction
  | CosmJsTransaction
  | CosmJsWasmTransaction
  | StarknetJsTransaction;

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

export interface CosmJsTransactionReceipt
  extends TypedTransactionReceiptBase<DeliverTxResponse> {
  type: ProviderType.CosmJs;
  receipt: DeliverTxResponse;
}

export interface CosmJsWasmTransactionReceipt
  extends TypedTransactionReceiptBase<DeliverTxResponse> {
  type: ProviderType.CosmJsWasm;
  receipt: DeliverTxResponse;
}

export interface StarknetJsTransactionReceipt
  extends TypedTransactionReceiptBase<StarknetReceiptTx> {
  type: ProviderType.Starknet;
  receipt: StarknetReceiptTx;
}

export type TypedTransactionReceipt =
  | EthersV5TransactionReceipt
  | ViemTransactionReceipt
  | SolanaWeb3TransactionReceipt
  | CosmJsTransactionReceipt
  | CosmJsWasmTransactionReceipt
  | StarknetJsTransactionReceipt;
