import {
  AccountInterface,
  ArgsOrCalldata,
  CairoCustomEnum,
  Contract,
  ProviderInterface,
  RawArgsArray,
  Uint256,
  addAddressPadding,
  num,
  uint256,
} from 'starknet';

import {
  ContractType,
  getCompiledContract,
} from '@hyperlane-xyz/starknet-core';
import {
  ZERO_ADDRESS_HEX_32,
  assert,
  bytes32ToAddress,
  ensure0x,
  isZeroishAddress,
  normalizeAddressStarknet,
} from '@hyperlane-xyz/utils';

import { StarknetAnnotatedTx } from './types.js';

type ObjectRecord = Record<string, unknown>;

function isObjectRecord(value: unknown): value is ObjectRecord {
  return !!value && typeof value === 'object';
}

function isUint256Like(value: unknown): value is Uint256 {
  if (!isObjectRecord(value)) return false;
  const low = value.low;
  const high = value.high;
  const isNumberish = (v: unknown) =>
    typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint';
  return isNumberish(low) && isNumberish(high);
}

function isPopulatedInvokeTx(
  value: unknown,
): value is {
  contractAddress: unknown;
  entrypoint: string;
  calldata?: RawArgsArray;
} {
  if (!isObjectRecord(value)) return false;
  return (
    'contractAddress' in value &&
    typeof value.entrypoint === 'string' &&
    (!('calldata' in value) || Array.isArray(value.calldata))
  );
}

export enum StarknetContractName {
  MAILBOX = 'mailbox',
  MESSAGE_ID_MULTISIG_ISM = 'messageid_multisig_ism',
  MERKLE_ROOT_MULTISIG_ISM = 'merkleroot_multisig_ism',
  ROUTING_ISM = 'domain_routing_ism',
  NOOP_ISM = 'noop_ism',
  HOOK = 'hook',
  MERKLE_TREE_HOOK = 'merkle_tree_hook',
  PROTOCOL_FEE = 'protocol_fee',
  VALIDATOR_ANNOUNCE = 'validator_announce',
  HYP_ERC20 = 'HypErc20',
  HYP_ERC20_COLLATERAL = 'HypErc20Collateral',
  HYP_NATIVE = 'HypNative',
  ETHER = 'Ether',
}

export const STARKNET_DEFAULT_FEE_TOKEN_ADDRESSES: Record<string, string> = {
  starknet:
    '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
  starknetsepolia:
    '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
  paradex: '0x7348407ebad690fec0cc8597e87dc16ef7b269a655ff72587dafff83d462be2',
  paradexsepolia:
    '0x06f373b346561036d98ea10fb3e60d2f459c872b1933b50b21fe6ef4fda3b75e',
};

export function getStarknetContract(
  contractName: string,
  address: string,
  providerOrAccount?: ProviderInterface | AccountInterface,
  contractType: ContractType = ContractType.CONTRACT,
): Contract {
  const { abi } = getCompiledContract(contractName, contractType);
  return new Contract(
    abi,
    normalizeStarknetAddressSafe(address),
    providerOrAccount,
  );
}

export function normalizeStarknetAddressSafe(value: unknown): string {
  if (typeof value === 'string') {
    if (isZeroishAddress(value)) return ZERO_ADDRESS_HEX_32;
    return addAddressPadding(ensure0x(normalizeAddressStarknet(value)));
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return addAddressPadding(ensure0x(BigInt(value).toString(16)));
  }

  if (isObjectRecord(value)) {
    if (isUint256Like(value)) {
      return addAddressPadding(
        ensure0x(uint256.uint256ToBN(value).toString(16)),
      );
    }

    if ('value' in value) {
      return normalizeStarknetAddressSafe(value.value);
    }

    if ('toString' in value && typeof value.toString === 'function') {
      return normalizeStarknetAddressSafe(value.toString());
    }
  }

  throw new Error(`Unable to normalize Starknet address: ${String(value)}`);
}

export function addressToEvmAddress(value: unknown): string {
  return bytes32ToAddress(normalizeStarknetAddressSafe(value));
}

export async function callContract(
  contract: Contract,
  method: string,
  args: RawArgsArray = [],
): Promise<unknown> {
  const fn = Reflect.get(contract, method);
  if (typeof fn === 'function') return fn(...args);

  const call = Reflect.get(contract, 'call');
  if (typeof call === 'function') {
    const callArgs: ArgsOrCalldata = args;
    return call(method, callArgs);
  }

  throw new Error(`Unable to call ${method} on contract ${contract.address}`);
}

export async function populateInvokeTx(
  contract: Contract,
  method: string,
  args: RawArgsArray = [],
): Promise<StarknetAnnotatedTx> {
  const populateTransaction = Reflect.get(contract, 'populateTransaction');
  const populated =
    isObjectRecord(populateTransaction) &&
    typeof populateTransaction[method] === 'function'
      ? populateTransaction[method]
      : undefined;
  if (typeof populated === 'function') {
    const tx = await populated(...args);
    if (isPopulatedInvokeTx(tx)) {
      return {
        kind: 'invoke',
        contractAddress: normalizeStarknetAddressSafe(tx.contractAddress),
        entrypoint: tx.entrypoint,
        calldata: tx.calldata ?? [],
      };
    }
  }

  return {
    kind: 'invoke',
    contractAddress: normalizeStarknetAddressSafe(contract.address),
    entrypoint: method,
    calldata: args,
  };
}

export function extractEnumVariant(value: unknown): string {
  if (!value) return '';

  if (value instanceof CairoCustomEnum) {
    return value.activeVariant();
  }

  if (
    isObjectRecord(value) &&
    'activeVariant' in value &&
    typeof value.activeVariant === 'function'
  ) {
    return value.activeVariant();
  }

  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value.toString();

  if (isObjectRecord(value)) {
    for (const [key, nested] of Object.entries(value)) {
      if (nested !== undefined && nested !== null && nested !== false) {
        return key;
      }
    }
  }

  return String(value);
}

export function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(value);
  if (value && typeof value === 'object') {
    if ('toString' in value && typeof value.toString === 'function') {
      return Number(value.toString());
    }
  }

  throw new Error(`Unable to coerce value to number: ${String(value)}`);
}

export function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string') return BigInt(value);
  if (isObjectRecord(value)) {
    if (isUint256Like(value)) {
      return uint256.uint256ToBN(value);
    }
    if ('toString' in value && typeof value.toString === 'function') {
      return BigInt(value.toString());
    }
  }

  throw new Error(`Unable to coerce value to bigint: ${String(value)}`);
}

export function getFeeTokenAddress(params: {
  chainName: string;
  nativeDenom?: string;
}): string {
  if (params.nativeDenom && !isZeroishAddress(params.nativeDenom)) {
    return normalizeStarknetAddressSafe(params.nativeDenom);
  }

  const token = STARKNET_DEFAULT_FEE_TOKEN_ADDRESSES[params.chainName];
  assert(token, `Missing Starknet fee token for chain ${params.chainName}`);
  return normalizeStarknetAddressSafe(token);
}

export function normalizeRoutersAddress(value: unknown): string {
  if (isUint256Like(value)) {
    return normalizeStarknetAddressSafe(num.toHex(uint256.uint256ToBN(value)));
  }
  return normalizeStarknetAddressSafe(value);
}
