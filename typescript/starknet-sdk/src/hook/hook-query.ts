import { type RpcProvider } from 'starknet';

import { AltVM } from '@hyperlane-xyz/provider-sdk';

import {
  StarknetContractName,
  callContract,
  extractEnumVariant,
  getStarknetContract,
  normalizeStarknetAddressSafe,
} from '../contracts.js';

function isProbeMiss(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    'entry point',
    'entrypoint',
    'viewable method not found in abi',
    'not found in abi',
    'not found in contract',
    'invalid message selector',
  ].some((needle) => message.toLowerCase().includes(needle));
}

function parseHookVariant(variant: string): AltVM.HookType {
  const upper = variant.toUpperCase();
  if (upper.includes('MERKLE_TREE')) return AltVM.HookType.MERKLE_TREE;
  if (upper.includes('PROTOCOL_FEE')) return AltVM.HookType.PROTOCOL_FEE;
  if (upper.includes('INTERCHAIN_GAS_PAYMASTER')) {
    return AltVM.HookType.INTERCHAIN_GAS_PAYMASTER;
  }
  return AltVM.HookType.CUSTOM;
}

export async function getHookType(
  provider: RpcProvider,
  hookAddress: string,
): Promise<AltVM.HookType> {
  try {
    const hook = getStarknetContract(
      StarknetContractName.HOOK,
      hookAddress,
      provider,
    );
    const hookType = await callContract(hook, 'hook_type');
    return parseHookVariant(extractEnumVariant(hookType));
  } catch (error) {
    if (!isProbeMiss(error)) throw error;
    return AltVM.HookType.CUSTOM;
  }
}

export function getMerkleTreeHookConfig(hookAddress: string): {
  address: string;
} {
  return { address: normalizeStarknetAddressSafe(hookAddress) };
}
