import { encodeSecp256k1Pubkey } from '@cosmjs/amino';
import { wasmTypes } from '@cosmjs/cosmwasm-stargate';
import { toUtf8 } from '@cosmjs/encoding';
import { Uint53 } from '@cosmjs/math';
import { Registry } from '@cosmjs/proto-signing';
import { defaultRegistryTypes } from '@cosmjs/stargate';
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx.js';
import { VersionedTransaction } from '@solana/web3.js';
import {
  BigNumber,
  providers as EV5Providers,
  type PopulatedTransaction as EV5Transaction,
  utils as EthersV5Utils,
} from 'ethers';
import { type EstimateGasParameters, isAddress as isViemAddress } from 'viem';

import {
  StargateClientCache,
  disconnectStargateClient,
  shouldCacheStargateClient,
} from '@hyperlane-xyz/cosmos-sdk';
import {
  Address,
  HexString,
  Numberish,
  ProtocolType,
  assert,
  convertToProtocolAddress,
  isNullish,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { ChainMetadata } from '../metadata/chainMetadataTypes.js';

import {
  AleoProvider,
  AleoTransaction,
  CosmJsNativeProvider,
  CosmJsNativeTransaction,
  CosmJsProvider,
  CosmJsTransaction,
  CosmJsWasmProvider,
  CosmJsWasmTransaction,
  EthersV5Provider,
  ProviderType,
  RadixProvider,
  RadixTransaction,
  SolanaWeb3Provider,
  SolanaWeb3Transaction,
  StarknetJsProvider,
  StarknetJsTransaction,
  TypedProvider,
  TypedTransaction,
  ViemProvider,
  ViemTransaction,
} from './ProviderType.js';
import {
  getJsonRpcErrorFrom,
  HyperlaneSmartProvider,
} from './SmartProvider/SmartProvider.js';
import { ProviderMethod } from './SmartProvider/ProviderMethods.js';

const EVM_MAX_BALANCE = (1n << 256n) - 1n;
const EVM_MAX_BALANCE_HEX = `0x${'f'.repeat(64)}`;

const logger = rootLogger.child({ module: 'transactionFeeEstimators' });

const INVALID_PARAMS_JSON_RPC_ERROR = -32602;

function isStateOverrideUnsupportedError(error: unknown): boolean {
  let current = error;
  while (current instanceof Error) {
    const { code, message } = getJsonRpcErrorFrom(current);
    if (
      Number(code) === INVALID_PARAMS_JSON_RPC_ERROR &&
      isUnsupportedStateOverrideMessage(message?.toLowerCase() ?? '')
    ) {
      return true;
    }
    current = current.cause;
  }

  return false;
}

function isUnsupportedStateOverrideMessage(message: string): boolean {
  return (
    message.includes('too many arguments') ||
    message.includes('invalid argument 2') ||
    ((message.includes('state override') ||
      message.includes('stateoverride')) &&
      (message.includes('not supported') || message.includes('unsupported')))
  );
}

export interface TransactionFeeEstimateOptions {
  /**
   * Attempts to estimate the fee without requiring the sender's native balance
   * to fund both the transaction value and its network fee. Defaults to false.
   * EVM estimation throws StateOverrideUnsupportedError when the RPC rejects
   * the required state override and no fallbackGasUnits are supplied.
   */
  ignoreSenderBalance?: boolean;
}

export interface EvmTransactionFeeEstimateOptions extends TransactionFeeEstimateOptions {
  /**
   * Positive gas units to use when an RPC rejects balance state overrides.
   * Supplying this value skips successful gas simulation and revert detection.
   */
  fallbackGasUnits?: bigint;
}

type EvmTypedTransaction = Extract<
  TypedTransaction,
  { type: ProviderType.EthersV5 | ProviderType.Viem }
>;
type TransactionFeeEstimateCommon = {
  provider: TypedProvider;
  chainMetadata: ChainMetadata;
  sender: Address;
  senderPubKey?: HexString;
};

export type TransactionFeeEstimateParams =
  | (TransactionFeeEstimateCommon &
      EvmTransactionFeeEstimateOptions & {
        transaction: EvmTypedTransaction;
      })
  | (TransactionFeeEstimateCommon &
      TransactionFeeEstimateOptions & {
        transaction: TypedTransaction;
        fallbackGasUnits?: never;
      });

export class StateOverrideUnsupportedError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      'RPC does not support eth_estimateGas state overrides; provide fallbackGasUnits to keep estimation balance-independent',
      options,
    );
    this.name = StateOverrideUnsupportedError.name;
  }
}

export interface TransactionFeeEstimate {
  gasUnits: number | bigint;
  gasPrice: number | bigint;
  fee: number | bigint;
}

const stargateClientCache = new StargateClientCache(32);

export function clearCachedStargateClients(): void {
  stargateClientCache.clear();
}

function getStargateClient(url: string) {
  return stargateClientCache.get(url);
}

export async function estimateTransactionFeeEthersV5({
  transaction,
  provider,
  sender,
  ignoreSenderBalance,
  fallbackGasUnits,
}: {
  transaction: EV5Transaction;
  provider: EV5Providers.Provider;
  sender: Address;
} & EvmTransactionFeeEstimateOptions): Promise<TransactionFeeEstimate> {
  assertValidFallbackGasUnits(fallbackGasUnits);
  const gasUnits = ignoreSenderBalance
    ? await estimateGasEthersV5WithBalanceOverride({
        transaction,
        provider,
        sender,
        fallbackGasUnits,
      })
    : await provider.estimateGas({
        ...transaction,
        from: sender,
      });
  return estimateTransactionFeeEthersV5ForGasUnits({
    provider,
    gasUnits: BigInt(gasUnits.toString()),
  });
}

async function estimateGasEthersV5WithBalanceOverride({
  transaction,
  provider,
  sender,
  fallbackGasUnits,
}: {
  transaction: EV5Transaction;
  provider: EV5Providers.Provider;
  sender: Address;
  fallbackGasUnits?: bigint;
}): Promise<BigNumber> {
  const resolvedTransaction = EV5Providers.JsonRpcProvider.hexlifyTransaction(
    await EthersV5Utils.resolveProperties({ ...transaction, from: sender }),
    { from: true },
  );
  const stateOverride = { [sender]: { balance: EVM_MAX_BALANCE_HEX } };

  try {
    if (provider instanceof HyperlaneSmartProvider) {
      return BigNumber.from(
        await provider.perform(ProviderMethod.EstimateGas, {
          transaction: resolvedTransaction,
          stateOverride,
        }),
      );
    }

    if ('send' in provider && typeof provider.send === 'function') {
      return BigNumber.from(
        await provider.send('eth_estimateGas', [
          resolvedTransaction,
          'latest',
          stateOverride,
        ]),
      );
    }

    throw new Error(
      'Ignoring sender balance requires a JSON-RPC Ethers provider',
    );
  } catch (error) {
    if (!isStateOverrideUnsupportedError(error)) throw error;
    if (isNullish(fallbackGasUnits)) {
      throw new StateOverrideUnsupportedError({ cause: error });
    }
    logger.warn(
      { estimator: 'ethersV5', jsonRpcCode: INVALID_PARAMS_JSON_RPC_ERROR },
      'Ethers v5 RPC rejected eth_estimateGas state override; using caller-provided fallback gas units without transaction simulation',
    );
    return BigNumber.from(fallbackGasUnits);
  }
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
    !isNullish(feeData.gasPrice)
      ? BigInt(feeData.gasPrice.toString())
      : undefined,
    !isNullish(feeData.maxFeePerGas)
      ? BigInt(feeData.maxFeePerGas.toString())
      : undefined,
  );
}

export async function estimateTransactionFeeViem({
  transaction,
  provider,
  sender,
  ignoreSenderBalance,
  fallbackGasUnits,
}: {
  transaction: ViemTransaction;
  provider: ViemProvider;
  sender: Address;
} & EvmTransactionFeeEstimateOptions): Promise<TransactionFeeEstimate> {
  assertValidFallbackGasUnits(fallbackGasUnits);
  assert(isViemAddress(sender), `Invalid EVM sender address: ${sender}`);
  const estimateGas = (includeStateOverride: boolean) =>
    provider.provider.estimateGas(
      getViemEstimateGasParameters(
        transaction.transaction,
        sender,
        includeStateOverride,
      ),
    );

  let gasUnits: bigint;
  try {
    gasUnits = await estimateGas(!!ignoreSenderBalance);
  } catch (error) {
    if (!ignoreSenderBalance || !isStateOverrideUnsupportedError(error))
      throw error;
    if (isNullish(fallbackGasUnits)) {
      throw new StateOverrideUnsupportedError({ cause: error });
    }
    logger.warn(
      { estimator: 'viem', jsonRpcCode: INVALID_PARAMS_JSON_RPC_ERROR },
      'Viem RPC rejected eth_estimateGas state override; using caller-provided fallback gas units without transaction simulation',
    );
    gasUnits = fallbackGasUnits;
  }
  const feeData = await provider.provider.estimateFeesPerGas();
  return computeEvmTxFee(gasUnits, feeData.gasPrice, feeData.maxFeePerGas);
}

function assertValidFallbackGasUnits(fallbackGasUnits?: bigint): void {
  assert(
    isNullish(fallbackGasUnits) || fallbackGasUnits > 0n,
    'fallbackGasUnits must be positive',
  );
}

function getViemEstimateGasParameters(
  transaction: ViemTransaction['transaction'],
  sender: `0x${string}`,
  includeStateOverride: boolean,
): EstimateGasParameters {
  const common = {
    account: sender,
    data: transaction.input,
    gas: transaction.gas,
    nonce: transaction.nonce,
    to: transaction.to,
    value: transaction.value,
    ...(includeStateOverride && {
      stateOverride: [{ address: sender, balance: EVM_MAX_BALANCE }],
    }),
  };

  switch (transaction.type) {
    case 'legacy':
      return {
        ...common,
        type: transaction.type,
        gasPrice: transaction.gasPrice,
      };
    case 'eip2930':
      return {
        ...common,
        type: transaction.type,
        accessList: transaction.accessList,
        gasPrice: transaction.gasPrice,
      };
    case 'eip1559':
      return {
        ...common,
        type: transaction.type,
        accessList: transaction.accessList,
        maxFeePerGas: transaction.maxFeePerGas,
        maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
      };
    case 'eip4844':
      return {
        ...common,
        type: transaction.type,
        accessList: transaction.accessList,
        blobVersionedHashes: transaction.blobVersionedHashes,
        maxFeePerBlobGas: transaction.maxFeePerBlobGas,
        maxFeePerGas: transaction.maxFeePerGas,
        maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
      };
    case 'eip7702':
      return {
        ...common,
        type: transaction.type,
        accessList: transaction.accessList,
        authorizationList: transaction.authorizationList,
        maxFeePerGas: transaction.maxFeePerGas,
        maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
      };
  }
}

function computeEvmTxFee(
  gasUnits: bigint,
  gasPrice?: bigint,
  maxFeePerGas?: bigint,
): TransactionFeeEstimate {
  let estGasPrice: bigint;
  if (!isNullish(maxFeePerGas)) {
    estGasPrice = maxFeePerGas;
  } else if (!isNullish(gasPrice)) {
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
  ignoreSenderBalance,
}: {
  transaction: SolanaWeb3Transaction;
  provider: SolanaWeb3Provider;
} & TransactionFeeEstimateOptions): Promise<TransactionFeeEstimate> {
  const connection = provider.provider;
  const inner = transaction.transaction;
  const message =
    inner instanceof VersionedTransaction
      ? inner.message
      : inner.compileMessage();
  // The two arms are intentionally identical: `Connection.simulateTransaction`
  // has separate overloads for legacy `Transaction` and `VersionedTransaction`
  // and the union satisfies neither, so we branch purely to narrow `inner` to a
  // concrete type and let overload resolution pick the matching signature.
  const [simulation, feeResponse] = await Promise.all([
    ignoreSenderBalance
      ? undefined
      : inner instanceof VersionedTransaction
        ? connection.simulateTransaction(inner)
        : connection.simulateTransaction(inner),
    connection.getFeeForMessage(message),
  ]);
  if (simulation) {
    assert(
      !simulation.value.err,
      `Solana gas estimation failed: ${JSON.stringify(simulation.value)}`,
    );
  }
  const gasUnits = BigInt(simulation?.value.unitsConsumed ?? 0);
  assert(
    feeResponse.value !== null,
    'Solana transaction fee estimation failed',
  );
  return {
    gasUnits,
    // Solana's message fee includes fixed signature and optional priority fees,
    // so it cannot be represented as one price per consumed compute unit.
    gasPrice: 0n,
    fee: BigInt(feeResponse.value),
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
  const stargateClient = getStargateClient(url);

  try {
    return await estimateTransactionFeeCosmJs({
      transaction: { type: ProviderType.CosmJs, transaction: message },
      provider: { type: ProviderType.CosmJs, provider: stargateClient },
      estimatedGasPrice,
      sender,
      senderPubKey,
      memo,
    });
  } catch (error) {
    stargateClientCache.evict(url, stargateClient);
    throw error;
  } finally {
    if (!shouldCacheStargateClient(url)) {
      disconnectStargateClient(stargateClient);
    } else {
      stargateClientCache.release(stargateClient);
    }
  }
}

export async function estimateTransactionFeeCosmJsNative({
  transaction,
  provider,
  estimatedGasPrice,
  senderAddress,
  senderPubKey,
}: {
  transaction: CosmJsNativeTransaction;
  provider: CosmJsNativeProvider;
  estimatedGasPrice: Numberish;
  senderAddress: Address;
  senderPubKey: HexString;
}): Promise<TransactionFeeEstimate> {
  const client = await provider.provider;

  return client.estimateTransactionFee({
    transaction: transaction.transaction,
    estimatedGasPrice: estimatedGasPrice.toString(),
    senderAddress,
    senderPubKey,
  });
}

// Starknet does not support gas estimation without starknet account
// TODO: Figure out a way to inject starknet account
export async function estimateTransactionFeeStarknet({
  transaction: _transaction,
  provider: _provider,
  sender: _sender,
}: {
  transaction: StarknetJsTransaction;
  provider: StarknetJsProvider;
  sender: Address;
}): Promise<TransactionFeeEstimate> {
  return { gasUnits: 0, gasPrice: 0, fee: 0 };
}

export async function estimateTransactionFeeRadix({
  transaction,
  provider,
}: {
  transaction: RadixTransaction;
  provider: RadixProvider;
}): Promise<TransactionFeeEstimate> {
  return provider.provider.estimateTransactionFee({
    transaction: transaction.transaction,
  });
}

export async function estimateTransactionFeeAleo({
  transaction,
  provider,
}: {
  transaction: AleoTransaction;
  provider: AleoProvider;
}): Promise<TransactionFeeEstimate> {
  return provider.provider.estimateTransactionFee({
    transaction: transaction.transaction,
  });
}

export function estimateTransactionFee({
  transaction,
  provider,
  chainMetadata,
  sender,
  senderPubKey,
  ignoreSenderBalance,
  fallbackGasUnits,
}: TransactionFeeEstimateParams): Promise<TransactionFeeEstimate> {
  if (
    transaction.type === ProviderType.EthersV5 &&
    provider.type === ProviderType.EthersV5
  ) {
    return estimateTransactionFeeEthersV5({
      transaction: transaction.transaction,
      provider: provider.provider,
      sender,
      ignoreSenderBalance,
      fallbackGasUnits,
    });
  } else if (
    transaction.type === ProviderType.Viem &&
    provider.type === ProviderType.Viem
  ) {
    return estimateTransactionFeeViem({
      transaction,
      provider,
      sender,
      ignoreSenderBalance,
      fallbackGasUnits,
    });
  } else if (
    transaction.type === ProviderType.SolanaWeb3 &&
    provider.type === ProviderType.SolanaWeb3
  ) {
    return estimateTransactionFeeSolanaWeb3({
      transaction,
      provider,
      ignoreSenderBalance,
    });
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
      senderAddress: sender,
      senderPubKey,
    });
  } else if (
    transaction.type === ProviderType.Starknet &&
    provider.type === ProviderType.Starknet
  ) {
    return estimateTransactionFeeStarknet({ transaction, provider, sender });
  } else if (
    transaction.type === ProviderType.Radix &&
    provider.type === ProviderType.Radix
  ) {
    return estimateTransactionFeeRadix({
      transaction,
      provider,
    });
  } else if (
    transaction.type === ProviderType.Aleo &&
    provider.type === ProviderType.Aleo
  ) {
    return estimateTransactionFeeAleo({
      transaction,
      provider,
    });
  } else if (
    transaction.type === ProviderType.Tron &&
    provider.type === ProviderType.Tron
  ) {
    // Tron is EVM-compatible; its typed transaction/provider use EthersV5 underlying types
    // Tron does not support EVM state overrides. TronJsonRpcProvider.estimateGas
    // already falls back to a balance-independent energy limit when estimation fails.
    sender = convertToProtocolAddress(sender, ProtocolType.Ethereum);
    return estimateTransactionFeeEthersV5({
      transaction: transaction.transaction,
      provider: provider.provider,
      sender,
    });
  } else {
    throw new Error(
      `Unsupported transaction type ${transaction.type} or provider type ${provider.type} for gas estimation`,
    );
  }
}
