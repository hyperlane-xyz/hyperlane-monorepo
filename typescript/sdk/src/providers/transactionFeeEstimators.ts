import { encodeSecp256k1Pubkey } from '@cosmjs/amino';
import { wasmTypes } from '@cosmjs/cosmwasm-stargate';
import { toUtf8 } from '@cosmjs/encoding';
import { Uint53 } from '@cosmjs/math';
import { Registry } from '@cosmjs/proto-signing';
import { StargateClient, defaultRegistryTypes } from '@cosmjs/stargate';
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx';
import { BigNumber } from 'ethers';

import { Address, HexString, Numberish, assert } from '@hyperlane-xyz/utils';

import { ChainMetadata } from '../metadata/chainMetadataTypes';

import {
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
} from './ProviderType';

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
  const gasUnits = await provider.provider.estimateGas({
    ...transaction.transaction,
    from: sender,
  });
  const feeData = await provider.provider.getFeeData();
  let gasPrice: BigNumber;
  if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
    gasPrice = feeData.maxFeePerGas.add(feeData.maxPriorityFeePerGas);
  } else if (feeData.gasPrice) {
    gasPrice = feeData.gasPrice;
  } else {
    throw new Error(`Invalid fee data: ${JSON.stringify(feeData)}`);
  }
  return {
    gasUnits: BigInt(gasUnits.toString()),
    gasPrice: BigInt(gasPrice.toString()),
    fee: BigInt(gasUnits.mul(gasPrice).toString()),
  };
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
  });
  const feeData = await provider.provider.estimateFeesPerGas();
  let gasPrice: bigint;
  if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
    gasPrice = feeData.maxFeePerGas + feeData.maxPriorityFeePerGas;
  } else if (feeData.gasPrice) {
    gasPrice = feeData.gasPrice;
  } else {
    throw new Error(`Invalid fee data: ${JSON.stringify(feeData)}`);
  }
  return {
    gasUnits,
    gasPrice,
    fee: gasUnits * gasPrice,
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
  assert(!value.err, `Solana gas estimation failed: ${value.err}`);
  const gasUnits = BigInt(value.unitsConsumed || 0);
  const recentFees = await connection.getRecentPrioritizationFees();
  const gasPrice = BigInt(recentFees[0].prioritizationFee);
  return {
    gasUnits,
    gasPrice,
    fee: gasUnits * gasPrice,
  };
}

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
  const url: string = wasmClient.tmClient.client.url;
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
  } else {
    throw new Error(
      `Unsupported transaction type ${transaction.type} or provider type ${provider.type} for gas estimation`,
    );
  }
}
