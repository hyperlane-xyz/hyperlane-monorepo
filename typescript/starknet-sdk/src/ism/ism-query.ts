import { type RpcProvider } from 'starknet';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
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
  if (
    upper.includes('TEST') ||
    upper.includes('NOOP') ||
    upper.includes('NULL') ||
    upper.includes('UNUSED')
  ) {
    return AltVM.IsmType.TEST_ISM;
  }
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
    return parseIsmVariant(extractEnumVariant(moduleType));
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
