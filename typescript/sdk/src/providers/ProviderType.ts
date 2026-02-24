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
import {
  Contract as StarknetContract,
  Invocation as StarknetInvocation,
  Provider as StarknetProvider,
  GetTransactionReceiptResponse as StarknetTxReceipt,
} from 'starknet';
import type {
  GetContractReturnType,
  PublicClient,
  Transaction as VTransaction,
  TransactionReceipt as VTransactionReceipt,
} from 'viem';

import {
  AleoProvider as AleoSDKProvider,
  AleoReceipt as AleoSDKReceipt,
  AleoTransaction as AleoSDKTransaction,
} from '@hyperlane-xyz/aleo-sdk';
import { CosmosNativeProvider } from '@hyperlane-xyz/cosmos-sdk';
import {
  RadixProvider as RadixSDKProvider,
  RadixSDKReceipt,
  RadixSDKTransaction,
} from '@hyperlane-xyz/radix-sdk';
import {
  Annotated,
  KnownProtocolType,
  ProtocolType,
} from '@hyperlane-xyz/utils';

import type { EvmProviderLike } from './evmTypes.js';

type EvmContractLike = { address?: string } & Record<string, unknown>;
type EvmTransactionLike = {
  to?: string;
  data?: string;
  value?: unknown;
} & Record<string, unknown>;
type EvmTransactionReceiptLike = {
  transactionHash?: string;
  logs?: unknown[];
} & Record<string, unknown>;
type ZkSyncProviderLike = EvmProviderLike;
type ZkSyncContractLike = EvmContractLike;
type ZkSyncTransactionLike = EvmTransactionLike;
type ZkSyncTransactionReceiptLike = EvmTransactionReceiptLike;

export enum ProviderType {
  Evm = 'evm',
  Viem = 'viem',
  SolanaWeb3 = 'solana-web3',
  CosmJs = 'cosmjs',
  CosmJsNative = 'cosmjs-native',
  CosmJsWasm = 'cosmjs-wasm',
  GnosisTxBuilder = 'gnosis-txBuilder',
  Starknet = 'starknet',
  ZkSync = 'zksync',
  Radix = 'radix',
  Aleo = 'aleo',
}

export type { KnownProtocolType };

export const PROTOCOL_TO_DEFAULT_PROVIDER_TYPE: Record<
  KnownProtocolType,
  ProviderType
> = {
  [ProtocolType.Ethereum]: ProviderType.Evm,
  [ProtocolType.Sealevel]: ProviderType.SolanaWeb3,
  [ProtocolType.Cosmos]: ProviderType.CosmJsWasm,
  [ProtocolType.CosmosNative]: ProviderType.CosmJsNative,
  [ProtocolType.Starknet]: ProviderType.Starknet,
  [ProtocolType.Radix]: ProviderType.Radix,
  [ProtocolType.Aleo]: ProviderType.Aleo,
};

export type ProviderMap<Value> = Partial<Record<ProviderType, Value>>;

type ProtocolTypesMapping = {
  [ProtocolType.Ethereum]: {
    transaction: EvmTransaction;
    provider: EvmProvider;
    contract: EvmContract;
    receipt: EvmTransactionReceipt;
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
  [ProtocolType.CosmosNative]: {
    transaction: CosmJsNativeTransaction;
    provider: CosmJsNativeProvider;
    contract: null;
    receipt: CosmJsNativeTransactionReceipt;
  };
  [ProtocolType.Starknet]: {
    transaction: StarknetJsTransaction;
    provider: StarknetJsProvider;
    contract: StarknetJsContract;
    receipt: StarknetJsTransactionReceipt;
  };
  [ProtocolType.Radix]: {
    transaction: RadixTransaction;
    provider: RadixProvider;
    contract: null;
    receipt: RadixTransactionReceipt;
  };
  [ProtocolType.Aleo]: {
    transaction: AleoTransaction;
    provider: AleoProvider;
    contract: null;
    receipt: AleoTransactionReceipt;
  };
  [ProtocolType.Unknown]: {
    transaction: never;
    provider: never;
    contract: never;
    receipt: never;
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

export type AnyProtocolTransaction = ProtocolTransaction<ProtocolType>;
export type ProtocolTransaction<T extends ProtocolType> =
  ProtocolTypedTransaction<T>['transaction'];

export type AnyProtocolReceipt = ProtocolReceipt<ProtocolType>;
export type ProtocolReceipt<T extends ProtocolType> =
  ProtocolTypedReceipt<T>['receipt'];

export type AnnotatedTypedTransaction<T extends ProtocolType> = Annotated<
  ProtocolTransaction<T>
>;

/**
 * Providers with discriminated union of type
 */

interface TypedProviderBase<T> {
  type: ProviderType;
  provider: T;
}

export interface EvmProvider extends TypedProviderBase<EvmProviderLike> {
  type: ProviderType.Evm;
  provider: EvmProviderLike;
}

export interface ViemProvider extends TypedProviderBase<PublicClient> {
  type: ProviderType.Viem;
  provider: PublicClient;
}

export interface SolanaWeb3Provider extends TypedProviderBase<Connection> {
  type: ProviderType.SolanaWeb3;
  provider: Connection;
}

export interface CosmJsProvider extends TypedProviderBase<
  Promise<StargateClient>
> {
  type: ProviderType.CosmJs;
  provider: Promise<StargateClient>;
}

export interface CosmJsWasmProvider extends TypedProviderBase<
  Promise<CosmWasmClient>
> {
  type: ProviderType.CosmJsWasm;
  provider: Promise<CosmWasmClient>;
}

export interface CosmJsNativeProvider extends TypedProviderBase<
  Promise<CosmosNativeProvider>
> {
  type: ProviderType.CosmJsNative;
  provider: Promise<CosmosNativeProvider>;
}

export interface StarknetJsProvider extends TypedProviderBase<StarknetProvider> {
  type: ProviderType.Starknet;
  provider: StarknetProvider;
}

export interface RadixProvider extends TypedProviderBase<RadixSDKProvider> {
  type: ProviderType.Radix;
  provider: RadixSDKProvider;
}

export interface AleoProvider extends TypedProviderBase<AleoSDKProvider> {
  type: ProviderType.Aleo;
  provider: AleoSDKProvider;
}

export interface ZKSyncProvider extends TypedProviderBase<ZkSyncProviderLike> {
  type: ProviderType.ZkSync;
  provider: ZkSyncProviderLike;
}

export type TypedProvider =
  | EvmProvider
  // | EthersV6Provider
  | ViemProvider
  | SolanaWeb3Provider
  | CosmJsProvider
  | CosmJsWasmProvider
  | CosmJsNativeProvider
  | StarknetJsProvider
  | ZKSyncProvider
  | RadixProvider
  | AleoProvider;

/**
 * Contracts with discriminated union of provider type
 */

interface TypedContractBase<T> {
  type: ProviderType;
  contract: T;
}

export interface EvmContract extends TypedContractBase<EvmContractLike> {
  type: ProviderType.Evm;
  contract: EvmContractLike;
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

export interface CosmJsWasmContract extends TypedContractBase<CosmWasmContract> {
  type: ProviderType.CosmJsWasm;
  contract: CosmWasmContract;
}

export interface StarknetJsContract extends TypedContractBase<StarknetContract> {
  type: ProviderType.Starknet;
  contract: StarknetContract;
}

export interface ZKSyncContract extends TypedContractBase<ZkSyncContractLike> {
  type: ProviderType.ZkSync;
  contract: ZkSyncContractLike;
}

export type TypedContract =
  | EvmContract
  // | EthersV6Contract
  | ViemContract
  | SolanaWeb3Contract
  | CosmJsContract
  | CosmJsWasmContract
  | StarknetJsContract
  | ZKSyncContract;

/**
 * Transactions with discriminated union of provider type
 */

interface TypedTransactionBase<T> {
  type: ProviderType;
  transaction: T;
}

export interface EvmTransaction extends TypedTransactionBase<EvmTransactionLike> {
  type: ProviderType.Evm;
  transaction: EvmTransactionLike;
}

export interface ViemTransaction extends TypedTransactionBase<VTransaction> {
  type: ProviderType.Viem;
  transaction: VTransaction;
}

export interface SolanaWeb3Transaction extends TypedTransactionBase<SolTransaction> {
  type: ProviderType.SolanaWeb3;
  transaction: SolTransaction;
}

export interface CosmJsTransaction extends TypedTransactionBase<CmTransaction> {
  type: ProviderType.CosmJs;
  transaction: CmTransaction;
}

export interface CosmJsWasmTransaction extends TypedTransactionBase<ExecuteInstruction> {
  type: ProviderType.CosmJsWasm;
  transaction: ExecuteInstruction;
}

export interface CosmJsNativeTransaction extends TypedTransactionBase<CmTransaction> {
  type: ProviderType.CosmJsNative;
  transaction: CmTransaction;
}

export interface StarknetJsTransaction extends TypedTransactionBase<StarknetInvocation> {
  type: ProviderType.Starknet;
  transaction: StarknetInvocation;
}

export interface RadixTransaction extends TypedTransactionBase<RadixSDKTransaction> {
  type: ProviderType.Radix;
  transaction: RadixSDKTransaction;
}

export interface AleoTransaction extends TypedTransactionBase<AleoSDKTransaction> {
  type: ProviderType.Aleo;
  transaction: AleoSDKTransaction;
}

export interface ZKSyncTransaction extends TypedTransactionBase<ZkSyncTransactionLike> {
  type: ProviderType.ZkSync;
  transaction: ZkSyncTransactionLike;
}

export type TypedTransaction =
  | EvmTransaction
  // | EthersV6Transaction
  | ViemTransaction
  | SolanaWeb3Transaction
  | CosmJsTransaction
  | CosmJsWasmTransaction
  | CosmJsNativeTransaction
  | StarknetJsTransaction
  | ZKSyncTransaction
  | RadixTransaction
  | AleoTransaction;

export type AnnotatedEvmTransaction = Annotated<EvmTransactionLike>;
export type AnnotatedEV5Transaction = AnnotatedEvmTransaction;

export type AnnotatedViemTransaction = Annotated<VTransaction>;

export type AnnotatedSolanaWeb3Transaction = Annotated<SolTransaction>;

export type AnnotatedCosmJsTransaction = Annotated<CmTransaction>;

export type AnnotatedCosmJsWasmTransaction = Annotated<ExecuteInstruction>;

export type AnnotatedCosmJsNativeTransaction = Annotated<CmTransaction>;

export type AnnotatedStarknetJsTransaction = Annotated<StarknetInvocation>;

export type AnnotatedZKSyncTransaction = Annotated<ZkSyncTransactionLike>;

export type AnnotatedRadixTransaction = Annotated<RadixSDKTransaction>;

export type TypedAnnotatedTransaction =
  | AnnotatedEvmTransaction
  | AnnotatedViemTransaction
  | AnnotatedSolanaWeb3Transaction
  | AnnotatedCosmJsTransaction
  | AnnotatedCosmJsWasmTransaction
  | AnnotatedCosmJsNativeTransaction
  | AnnotatedStarknetJsTransaction
  | AnnotatedZKSyncTransaction
  | AnnotatedRadixTransaction;

/**
 * Transaction receipt/response with discriminated union of provider type
 */

interface TypedTransactionReceiptBase<T> {
  type: ProviderType;
  receipt: T;
}

export interface EvmTransactionReceipt extends TypedTransactionReceiptBase<EvmTransactionReceiptLike> {
  type: ProviderType.Evm;
  receipt: EvmTransactionReceiptLike;
}

export interface ViemTransactionReceipt extends TypedTransactionReceiptBase<VTransactionReceipt> {
  type: ProviderType.Viem;
  receipt: VTransactionReceipt;
}

export interface SolanaWeb3TransactionReceipt extends TypedTransactionReceiptBase<SolTransactionReceipt> {
  type: ProviderType.SolanaWeb3;
  receipt: SolTransactionReceipt;
}

export interface CosmJsTransactionReceipt extends TypedTransactionReceiptBase<DeliverTxResponse> {
  type: ProviderType.CosmJs;
  receipt: DeliverTxResponse;
}

export interface CosmJsWasmTransactionReceipt extends TypedTransactionReceiptBase<DeliverTxResponse> {
  type: ProviderType.CosmJsWasm;
  receipt: DeliverTxResponse;
}

export interface CosmJsNativeTransactionReceipt extends TypedTransactionReceiptBase<DeliverTxResponse> {
  type: ProviderType.CosmJsNative;
  receipt: DeliverTxResponse;
}

export interface StarknetJsTransactionReceipt extends TypedTransactionReceiptBase<StarknetTxReceipt> {
  type: ProviderType.Starknet;
  receipt: StarknetTxReceipt;
}

export interface ZKSyncTransactionReceipt extends TypedTransactionReceiptBase<ZkSyncTransactionReceiptLike> {
  type: ProviderType.ZkSync;
  receipt: ZkSyncTransactionReceiptLike;
}

export interface RadixTransactionReceipt extends TypedTransactionReceiptBase<RadixSDKReceipt> {
  type: ProviderType.Radix;
  receipt: RadixSDKReceipt;
}

export interface AleoTransactionReceipt extends TypedTransactionReceiptBase<AleoSDKReceipt> {
  type: ProviderType.Aleo;
  receipt: AleoSDKReceipt;
}

export type TypedTransactionReceipt =
  | EvmTransactionReceipt
  | ViemTransactionReceipt
  | SolanaWeb3TransactionReceipt
  | CosmJsTransactionReceipt
  | CosmJsWasmTransactionReceipt
  | CosmJsNativeTransactionReceipt
  | StarknetJsTransactionReceipt
  | ZKSyncTransactionReceipt
  | RadixTransactionReceipt
  | AleoTransactionReceipt;
