import { SigningCosmWasmClient } from '@cosmjs/cosmwasm-stargate';
import { toUtf8 } from '@cosmjs/encoding';
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { SigningStargateClient } from '@cosmjs/stargate';
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx';
import { BigNumber } from 'ethers';

import { Address, Numberish, assert } from '@hyperlane-xyz/utils';

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

export async function estimateTransactionFeeEthersV5(
  typedTx: EthersV5Transaction,
  typedProvider: EthersV5Provider,
  sender: Address,
): Promise<TransactionFeeEstimate> {
  const gasUnits = await typedProvider.provider.estimateGas({
    ...typedTx.transaction,
    from: sender,
  });
  const feeData = await typedProvider.provider.getFeeData();
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

export async function estimateTransactionFeeViem(
  typedTx: ViemTransaction,
  typedProvider: ViemProvider,
  sender: Address,
): Promise<TransactionFeeEstimate> {
  const gasUnits = await typedProvider.provider.estimateGas({
    ...typedTx.transaction,
    blockNumber: undefined,
    account: sender as `0x${string}`,
  });
  const feeData = await typedProvider.provider.estimateFeesPerGas();
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

export async function estimateTransactionFeeSolanaWeb3(
  typedTx: SolanaWeb3Transaction,
  typedProvider: SolanaWeb3Provider,
): Promise<TransactionFeeEstimate> {
  const connection = typedProvider.provider;
  const { value } = await connection.simulateTransaction(typedTx.transaction);
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

export async function estimateTransactionFeeCosmJs(
  typedTx: CosmJsTransaction,
  typedProvider: CosmJsProvider,
  estimatedGasPrice: Numberish,
): Promise<TransactionFeeEstimate> {
  // @ts-ignore access a private field here to extract client URL
  const url: string = typedProvider.provider.tmClient.client.url;
  const randomWallet = await DirectSecp256k1HdWallet.generate();
  const randomAddress = (await randomWallet.getAccounts())[0].address;
  const signingClient = await SigningStargateClient.connectWithSigner(
    url,
    randomWallet,
  );
  const gasUnits = await signingClient.simulate(
    randomAddress,
    [typedTx.transaction],
    undefined,
  );
  const gasPrice = parseFloat(estimatedGasPrice.toString());

  // Note: there's no way to fetch gas prices on Cosmos so we rely on
  // the estimate value arg in which typically comes from the ChainMetadata
  return {
    gasUnits,
    gasPrice,
    fee: gasUnits * gasPrice,
  };
}

// TODO DRY up with fn above
export async function estimateTransactionFeeCosmJsWasm(
  typedTx: CosmJsWasmTransaction,
  typedProvider: CosmJsWasmProvider,
  estimatedGasPrice: Numberish,
): Promise<TransactionFeeEstimate> {
  // @ts-ignore access a private field here to extract client URL
  const url: string = typedProvider.provider.tmClient.client.url;
  const randomWallet = await DirectSecp256k1HdWallet.generate();
  const randomAddress = (await randomWallet.getAccounts())[0].address;
  const signingClient = await SigningCosmWasmClient.connectWithSigner(
    url,
    randomWallet,
  );
  const message = {
    typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
    value: MsgExecuteContract.fromPartial({
      sender: randomAddress,
      contract: typedTx.transaction.contractAddress,
      msg: toUtf8(JSON.stringify(typedTx.transaction.msg)),
      funds: [...(typedTx.transaction.funds || [])],
    }),
  };
  const gasUnits = await signingClient.simulate(
    randomAddress,
    [message],
    undefined,
  );
  const gasPrice = parseFloat(estimatedGasPrice.toString());

  // Note: there's no way to fetch gas prices on Cosmos so we rely on
  // the estimate value arg in which typically comes from the ChainMetadata
  return {
    gasUnits,
    gasPrice,
    fee: gasUnits * gasPrice,
  };
}

export function estimateTransactionFee(
  tx: TypedTransaction,
  provider: TypedProvider,
  sender: Address,
  txOverrides?: Record<string, unknown>,
): Promise<TransactionFeeEstimate> {
  if (
    tx.type === ProviderType.EthersV5 &&
    provider.type === ProviderType.EthersV5
  ) {
    return estimateTransactionFeeEthersV5(tx, provider, sender);
  } else if (
    tx.type === ProviderType.Viem &&
    provider.type === ProviderType.Viem
  ) {
    return estimateTransactionFeeViem(tx, provider, sender);
  } else if (
    tx.type === ProviderType.SolanaWeb3 &&
    provider.type === ProviderType.SolanaWeb3
  ) {
    return estimateTransactionFeeSolanaWeb3(tx, provider);
  } else if (
    tx.type === ProviderType.CosmJs &&
    provider.type === ProviderType.CosmJs
  ) {
    const gasPrice = txOverrides?.gasPrice as Numberish;
    assert(gasPrice, 'gasPrice required for CosmJS gas estimation');
    return estimateTransactionFeeCosmJs(tx, provider, gasPrice);
  } else if (
    tx.type === ProviderType.CosmJsWasm &&
    provider.type === ProviderType.CosmJsWasm
  ) {
    const gasPrice = txOverrides?.gasPrice as Numberish;
    assert(gasPrice, 'gasPrice required for CosmJsWasm gas estimation');
    return estimateTransactionFeeCosmJsWasm(tx, provider, gasPrice);
  } else {
    throw new Error(
      `Unsupported transaction type ${tx.type} or provider type ${provider.type} for gas estimation`,
    );
  }
}
