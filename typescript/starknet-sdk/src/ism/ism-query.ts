import { type RpcProvider } from 'starknet';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { getContractClassHash } from '@hyperlane-xyz/starknet-core/runtime';
import { assert } from '@hyperlane-xyz/utils';

import {
  StarknetContractName,
  addressToEvmAddress,
  callContract,
  extractEnumVariant,
  getStarknetContract,
  isProbeMiss,
  normalizeStarknetAddressSafe,
  toNumber,
} from '../contracts.js';

function parseIsmVariant(variant: string): AltVM.IsmType {
  const upper = variant.toUpperCase();
  if (upper === 'AGGREGATION') return AltVM.IsmType.AGGREGATION;
  if (upper.includes('MERKLE_ROOT_MULTISIG')) {
    return AltVM.IsmType.MERKLE_ROOT_MULTISIG;
  }
  if (upper.includes('MESSAGE_ID_MULTISIG')) {
    return AltVM.IsmType.MESSAGE_ID_MULTISIG;
  }
  if (upper.includes('ROUTING')) {
    return AltVM.IsmType.ROUTING;
  }
  return AltVM.IsmType.CUSTOM;
}

export async function getIsmType(
  provider: RpcProvider,
  ismAddress: string,
): Promise<AltVM.IsmType> {
  try {
    const ism = getStarknetContract(
      StarknetContractName.MERKLE_ROOT_MULTISIG_ISM,
      ismAddress,
      provider,
    );
    const moduleType = await callContract(ism, 'module_type');
    const variant = extractEnumVariant(moduleType).toUpperCase();
    if (variant === 'NULL') {
      // NULL is shared by pausable and noop ISMs; it does not mean accept-all.
      const pausable = getStarknetContract(
        StarknetContractName.PAUSABLE_ISM,
        ismAddress,
        provider,
      );
      try {
        await callContract(pausable, 'is_paused');
        return AltVM.IsmType.PAUSABLE;
      } catch (error) {
        if (!isProbeMiss(error)) throw error;
      }
      const classHash = await provider.getClassHashAt(ismAddress);
      return BigInt(classHash) ===
        BigInt(getContractClassHash(StarknetContractName.NOOP_ISM))
        ? AltVM.IsmType.TEST_ISM
        : AltVM.IsmType.CUSTOM;
    }
    return parseIsmVariant(variant);
  } catch (error) {
    if (!isProbeMiss(error)) throw error;
    return AltVM.IsmType.CUSTOM;
  }
}

export interface MultisigIsmConfig {
  address: string;
  threshold: number;
  validators: string[];
}

async function getMultisigIsmConfig(
  provider: RpcProvider,
  ismAddress: string,
  contractName: StarknetContractName,
): Promise<MultisigIsmConfig> {
  const ism = getStarknetContract(contractName, ismAddress, provider);
  const [validators, threshold] = await Promise.all([
    callContract(ism, 'get_validators'),
    callContract(ism, 'get_threshold'),
  ]);

  assert(Array.isArray(validators), 'Expected Starknet validators array');

  return {
    address: normalizeStarknetAddressSafe(ismAddress),
    threshold: toNumber(threshold),
    validators: validators.map((v) => addressToEvmAddress(v)),
  };
}

export async function getMessageIdMultisigIsmConfig(
  provider: RpcProvider,
  ismAddress: string,
): Promise<MultisigIsmConfig> {
  return getMultisigIsmConfig(
    provider,
    ismAddress,
    StarknetContractName.MESSAGE_ID_MULTISIG_ISM,
  );
}

export async function getMerkleRootMultisigIsmConfig(
  provider: RpcProvider,
  ismAddress: string,
): Promise<MultisigIsmConfig> {
  return getMultisigIsmConfig(
    provider,
    ismAddress,
    StarknetContractName.MERKLE_ROOT_MULTISIG_ISM,
  );
}

export interface RoutingIsmConfig {
  address: string;
  owner: string;
  routes: { domainId: number; ismAddress: string }[];
}

export async function getRoutingIsmConfig(
  provider: RpcProvider,
  ismAddress: string,
): Promise<RoutingIsmConfig> {
  const ism = getStarknetContract(
    StarknetContractName.ROUTING_ISM,
    ismAddress,
    provider,
  );
  const [owner, domains] = await Promise.all([
    callContract(ism, 'owner'),
    callContract(ism, 'domains'),
  ]);

  assert(Array.isArray(domains), 'Expected Starknet routing domains array');

  const routes = await Promise.all(
    domains.map(async (domainId) => {
      const routeAddress = await callContract(ism, 'module', [domainId]);
      return {
        domainId: toNumber(domainId),
        ismAddress: normalizeStarknetAddressSafe(routeAddress),
      };
    }),
  );

  return {
    address: normalizeStarknetAddressSafe(ismAddress),
    owner: normalizeStarknetAddressSafe(owner),
    routes,
  };
}

export function getNoopIsmConfig(ismAddress: string): { address: string } {
  return { address: normalizeStarknetAddressSafe(ismAddress) };
}

export async function getAggregationIsmConfig(
  provider: RpcProvider,
  ismAddress: string,
): Promise<{
  address: string;
  modules: string[];
  threshold: number;
}> {
  const ism = getStarknetContract(
    StarknetContractName.AGGREGATION_ISM,
    ismAddress,
    provider,
  );
  const [modules, threshold] = await Promise.all([
    callContract(ism, 'get_modules'),
    callContract(ism, 'get_threshold'),
  ]);
  assert(Array.isArray(modules), 'Expected Starknet aggregation modules array');
  return {
    address: normalizeStarknetAddressSafe(ismAddress),
    modules: modules.map(normalizeStarknetAddressSafe),
    threshold: toNumber(threshold),
  };
}

export async function getPausableIsmConfig(
  provider: RpcProvider,
  ismAddress: string,
): Promise<{
  address: string;
  owner: string;
  paused: boolean;
}> {
  const ism = getStarknetContract(
    StarknetContractName.PAUSABLE_ISM,
    ismAddress,
    provider,
  );
  const [owner, paused] = await Promise.all([
    callContract(ism, 'owner'),
    callContract(ism, 'is_paused'),
  ]);
  assert(typeof paused === 'boolean', 'Expected Starknet paused boolean');
  return {
    address: normalizeStarknetAddressSafe(ismAddress),
    owner: normalizeStarknetAddressSafe(owner),
    paused,
  };
}
