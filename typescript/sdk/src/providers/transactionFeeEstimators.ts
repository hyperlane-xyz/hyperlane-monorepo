import { encodeSecp256k1Pubkey } from '@cosmjs/amino';
import { wasmTypes } from '@cosmjs/cosmwasm-stargate';
import { toUtf8 } from '@cosmjs/encoding';
import { Uint53 } from '@cosmjs/math';
import { Registry } from '@cosmjs/proto-signing';
import { StargateClient, defaultRegistryTypes } from '@cosmjs/stargate';
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx.js';

import { Address, HexString, Numberish, assert } from '@hyperlane-xyz/utils';

import { ChainMetadata } from '../metadata/chainMetadataTypes.js';

import {
  CosmJsNativeProvider,
  CosmJsNativeTransaction,
  CosmJsProvider,
  CosmJsTransaction,
  CosmJsWasmProvider,
  CosmJsWasmTransaction,
  EthersV5Provider,
  EthersV5Transaction,
  ProviderType,
  SolanaWeb3Provider,
  SolanaWeb3Transaction,
  TypedProvider,
  TypedTransaction,
  ViemProvider,
  ViemTransaction,
} from './ProviderType.js';

export interface TransactionFeeEstimate {
  gasUnits: number | bigint;
  gasPrice: number | bigint;
  fee: number | bigint;
}

export async function estimateTransactionFeeEthersV5({
  transaction,
  provider,
  sender,
}: {
  transaction: EthersV5Transaction;
  provider: EthersV5Provider;
  sender: Address;
}): Promise<TransactionFeeEstimate> {
  const ethersProvider = provider.provider;
  const gasUnits = await ethersProvider.estimateGas({
    ...transaction.transaction,
    from: sender,
  });
  return estimateTransactionFeeEthersV5ForGasUnits({
    provider: ethersProvider,
    gasUnits: BigInt(gasUnits.toString()),
  });
}

// Separating out inner function to allow WarpCore to reuse logic
export async function estimateTransactionFeeEthersV5ForGasUnits({
  provider,
  gasUnits,
}: {
  provider: EthersV5Provider['provider'];
  gasUnits: bigint;
}): Promise<TransactionFeeEstimate> {
  const feeData = await provider.getFeeData();
  return computeEvmTxFee(
    gasUnits,
    feeData.gasPrice ? BigInt(feeData.gasPrice.toString()) : undefined,
    feeData.maxFeePerGas ? BigInt(feeData.maxFeePerGas.toString()) : undefined,
    feeData.maxPriorityFeePerGas
      ? BigInt(feeData.maxPriorityFeePerGas.toString())
      : undefined,
  );
}

export async function estimateTransactionFeeViem({
  transaction,
  provider,
  sender,
}: {
  transaction: ViemTransaction;
  provider: ViemProvider;
  sender: Address;
}): Promise<TransactionFeeEstimate> {
  const gasUnits = await provider.provider.estimateGas({
    ...transaction.transaction,
    blockNumber: undefined,
    account: sender as `0x${string}`,
  } as any); // Cast to silence overly-protective type enforcement from viem here
  const feeData = await provider.provider.estimateFeesPerGas();
  return computeEvmTxFee(
    gasUnits,
    feeData.gasPrice,
    feeData.maxFeePerGas,
    feeData.maxPriorityFeePerGas,
  );
}

function computeEvmTxFee(
  gasUnits: bigint,
  gasPrice?: bigint,
  maxFeePerGas?: bigint,
  maxPriorityFeePerGas?: bigint,
): TransactionFeeEstimate {
  let estGasPrice: bigint;
  if (maxFeePerGas && maxPriorityFeePerGas) {
    estGasPrice = maxFeePerGas + maxPriorityFeePerGas;
  } else if (gasPrice) {
    estGasPrice = gasPrice;
  } else {
    throw new Error('Invalid fee data, neither 1559 nor legacy');
  }
  return {
    gasUnits,
    gasPrice: estGasPrice,
    fee: gasUnits * estGasPrice,
  };
}

export async function estimateTransactionFeeSolanaWeb3({
  provider,
  transaction,
}: {
  transaction: SolanaWeb3Transaction;
  provider: SolanaWeb3Provider;
}): Promise<TransactionFeeEstimate> {
  const connection = provider.provider;
  const { value } = await connection.simulateTransaction(
    transaction.transaction,
  );
  assert(!value.err, `Solana gas estimation failed: ${JSON.stringify(value)}`);
  const gasUnits = BigInt(value.unitsConsumed || 0);
  const recentFees = await connection.getRecentPrioritizationFees();
  const gasPrice = BigInt(recentFees[0].prioritizationFee);
  return {
    gasUnits,
    gasPrice,
    fee: gasUnits * gasPrice,
  };
}

// This is based on a reverse-engineered version of the
// SigningStargateClient's simulate function. It cannot be
// used here because it requires access to the private key.
// https://github.com/cosmos/cosmjs/issues/1568
export async function estimateTransactionFeeCosmJs({
  transaction,
  provider,
  estimatedGasPrice,
  sender,
  senderPubKey,
  memo,
}: {
  transaction: CosmJsTransaction;
  provider: CosmJsProvider;
  estimatedGasPrice: Numberish;
  sender: Address;
  // Unfortunately the sender pub key is required for this simulation.
  // For accounts that have sent a tx, the pub key could be fetched via
  // a StargateClient getAccount call. However that will fail for addresses
  // that have not yet sent a tx on the queried chain.
  // Related: https://github.com/cosmos/cosmjs/issues/889
  senderPubKey: HexString;
  memo?: string;
}): Promise<TransactionFeeEstimate> {
  const stargateClient = await provider.provider;
  const message = transaction.transaction;
  const registry = new Registry([...defaultRegistryTypes, ...wasmTypes]);
  const encodedMsg = registry.encodeAsAny(message);
  const encodedPubkey = encodeSecp256k1Pubkey(Buffer.from(senderPubKey, 'hex'));
  const { sequence } = await stargateClient.getSequence(sender);
  const { gasInfo } = await stargateClient
    // @ts-ignore force access to protected method
    .forceGetQueryClient()
    .tx.simulate([encodedMsg], memo, encodedPubkey, sequence);
  assert(gasInfo, 'Gas estimation failed');
  const gasUnits = Uint53.fromString(gasInfo.gasUsed.toString()).toNumber();

  const gasPrice = parseFloat(estimatedGasPrice.toString());

  return {
    gasUnits,
    gasPrice,
    fee: Math.floor(gasUnits * gasPrice),
  };
}

export async function estimateTransactionFeeCosmJsWasm({
  transaction,
  provider,
  estimatedGasPrice,
  sender,
  senderPubKey,
  memo,
}: {
  transaction: CosmJsWasmTransaction;
  provider: CosmJsWasmProvider;
  estimatedGasPrice: Numberish;
  sender: Address;
  senderPubKey: HexString;
  memo?: string;
}): Promise<TransactionFeeEstimate> {
  const message = {
    typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
    value: MsgExecuteContract.fromPartial({
      sender,
      contract: transaction.transaction.contractAddress,
      msg: toUtf8(JSON.stringify(transaction.transaction.msg)),
      funds: [...(transaction.transaction.funds || [])],
    }),
  };
  const wasmClient = await provider.provider;
  // @ts-ignore access a private field here to extract client URL
  const url: string = wasmClient.cometClient.client.url;
  const stargateClient = StargateClient.connect(url);

  return estimateTransactionFeeCosmJs({
    transaction: { type: ProviderType.CosmJs, transaction: message },
    provider: { type: ProviderType.CosmJs, provider: stargateClient },
    estimatedGasPrice,
    sender,
    senderPubKey,
    memo,
  });
}

export async function estimateTransactionFeeCosmJsNative({
  transaction,
  provider,
  estimatedGasPrice,
  sender,
  senderPubKey,
  memo,
}: {
  transaction: CosmJsNativeTransaction;
  provider: CosmJsNativeProvider;
  estimatedGasPrice: Numberish;
  sender: Address;
  senderPubKey: HexString;
  memo?: string;
}): Promise<TransactionFeeEstimate> {
  const client = await provider.provider;
  const message = client.registry.encodeAsAny(transaction.transaction);
  const pubKey = encodeSecp256k1Pubkey(Buffer.from(senderPubKey, 'hex'));

  const gasUnits = await client.simulate(sender, pubKey, [message], memo);
  const gasPrice = parseFloat(estimatedGasPrice.toString());

  return {
    gasUnits,
    gasPrice,
    fee: Math.floor(gasUnits * gasPrice),
  };
}

export function estimateTransactionFee({
  transaction,
  provider,
  chainMetadata,
  sender,
  senderPubKey,
}: {
  transaction: TypedTransaction;
  provider: TypedProvider;
  chainMetadata: ChainMetadata;
  sender: Address;
  senderPubKey?: HexString;
}): Promise<TransactionFeeEstimate> {
  if (
    transaction.type === ProviderType.EthersV5 &&
    provider.type === ProviderType.EthersV5
  ) {
    return estimateTransactionFeeEthersV5({ transaction, provider, sender });
  } else if (
    transaction.type === ProviderType.Viem &&
    provider.type === ProviderType.Viem
  ) {
    return estimateTransactionFeeViem({ transaction, provider, sender });
  } else if (
    transaction.type === ProviderType.SolanaWeb3 &&
    provider.type === ProviderType.SolanaWeb3
  ) {
    return estimateTransactionFeeSolanaWeb3({ transaction, provider });
  } else if (
    transaction.type === ProviderType.CosmJs &&
    provider.type === ProviderType.CosmJs
  ) {
    const { transactionOverrides } = chainMetadata;
    const estimatedGasPrice = transactionOverrides?.gasPrice as Numberish;
    assert(estimatedGasPrice, 'gasPrice required for CosmJS gas estimation');
    assert(senderPubKey, 'senderPubKey required for CosmJS gas estimation');
    return estimateTransactionFeeCosmJs({
      transaction,
      provider,
      estimatedGasPrice,
      sender,
      senderPubKey,
    });
  } else if (
    transaction.type === ProviderType.CosmJsWasm &&
    provider.type === ProviderType.CosmJsWasm
  ) {
    const { transactionOverrides } = chainMetadata;
    const estimatedGasPrice = transactionOverrides?.gasPrice as Numberish;
    assert(estimatedGasPrice, 'gasPrice required for CosmJS gas estimation');
    assert(senderPubKey, 'senderPubKey required for CosmJS gas estimation');
    return estimateTransactionFeeCosmJsWasm({
      transaction,
      provider,
      estimatedGasPrice,
      sender,
      senderPubKey,
    });
  } else if (
    transaction.type === ProviderType.CosmJsNative &&
    provider.type === ProviderType.CosmJsNative
  ) {
    const { transactionOverrides } = chainMetadata;
    const estimatedGasPrice = transactionOverrides?.gasPrice as Numberish;
    assert(estimatedGasPrice, 'gasPrice required for CosmJS gas estimation');
    assert(senderPubKey, 'senderPubKey required for CosmJS gas estimation');
    return estimateTransactionFeeCosmJsNative({
      transaction,
      provider,
      estimatedGasPrice,
      sender,
      senderPubKey,
    });
  } else {
    throw new Error(
      `Unsupported transaction type ${transaction.type} or provider type ${provider.type} for gas estimation`,
    );
  }
}
