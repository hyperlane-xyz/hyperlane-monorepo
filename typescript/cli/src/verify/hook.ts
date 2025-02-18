import { ContractFactory } from 'ethers';

import {
  ChainMap,
  EvmHookReader,
  MultiProvider,
  hookContracts,
  hookFactories,
} from '@hyperlane-xyz/sdk';
import { Address, objFilter } from '@hyperlane-xyz/utils';

import { requestAndSaveApiKeys } from '../context/context.js';
import { CommandContext } from '../context/types.js';

import { verifyProxyAndImplementation } from './helpers.js';

// Zircuit does not have an external API: https://docs.zircuit.com/dev-tools/block-explorer

export async function runVerifyHook({
  context,
  address,
  chainName,
}: {
  context: CommandContext;
  address: string;
  chainName: string;
}) {
  const { chainMetadata, registry, skipConfirmation } = context;
  let apiKeys: ChainMap<string> = {};
  if (!skipConfirmation)
    apiKeys = await requestAndSaveApiKeys([chainName], chainMetadata, registry);
  return verifyProxyAndImplementation({
    context,
    address,
    chainName,
    apiKeys,
    getContractFactoryAndName: getHookFactoryAndName,
  });
}

async function getHookFactoryAndName(
  multiProvider: MultiProvider,
  chainName: string,
  warpRouteAddress: Address,
): Promise<{
  factory: ContractFactory;
  contractName: string;
}> {
  const warpRouteReader = new EvmHookReader(multiProvider, chainName);
  const hookType = (await warpRouteReader.deriveHookConfig(warpRouteAddress))
    .type;

  const factory = objFilter(
    hookFactories,
    (t, _contract): _contract is any => t === hookType,
  )[hookType];

  const contractName = hookContracts[hookType];
  return { factory, contractName };
}
