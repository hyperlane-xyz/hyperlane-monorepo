import {
  AccountInterface,
  CairoCustomEnum,
  Contract,
  ProviderInterface,
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

  if (value && typeof value === 'object') {
    if ('low' in value || 'high' in value) {
      return addAddressPadding(
        ensure0x(uint256.uint256ToBN(value as any).toString(16)),
      );
    }

    if ('value' in value) {
      return normalizeStarknetAddressSafe((value as any).value);
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
  args: unknown[] = [],
): Promise<any> {
  const fn = (contract as any)[method];
  if (typeof fn === 'function') return fn(...args);

  const call = (contract as any).call;
  if (typeof call === 'function') return call(method, args);

  throw new Error(`Unable to call ${method} on contract ${contract.address}`);
}

export async function populateInvokeTx(
  contract: Contract,
  method: string,
  args: unknown[] = [],
): Promise<StarknetAnnotatedTx> {
  const populated = (contract as any).populateTransaction?.[method];
  if (typeof populated === 'function') {
    const tx = await populated(...args);
    return { kind: 'invoke', ...tx };
  }

  return {
    kind: 'invoke',
    contractAddress: normalizeStarknetAddressSafe(contract.address),
    entrypoint: method,
    calldata: args as any[],
  };
}

export function extractEnumVariant(value: unknown): string {
  if (!value) return '';

  if (
    typeof value === 'object' &&
    'activeVariant' in value &&
    typeof (value as CairoCustomEnum).activeVariant === 'function'
  ) {
    return (value as CairoCustomEnum).activeVariant();
  }

  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value.toString();

  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, any>)) {
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
  if (value && typeof value === 'object') {
    if ('low' in value || 'high' in value) {
      return uint256.uint256ToBN(value as any);
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
  if (value && typeof value === 'object' && ('low' in value || 'high' in value)) {
    return normalizeStarknetAddressSafe(num.toHex(uint256.uint256ToBN(value as any)));
  }
  return normalizeStarknetAddressSafe(value);
}
