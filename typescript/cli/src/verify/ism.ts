import { ContractFactory } from 'ethers';
import _ from 'lodash';

import {
  ChainMap,
  EvmIsmReader,
  MultiProvider,
  ismContracts,
  ismFactories,
} from '@hyperlane-xyz/sdk';
import { Address, objFilter } from '@hyperlane-xyz/utils';

import { requestAndSaveApiKeys } from '../context/context.js';
import { CommandContext } from '../context/types.js';

import { verifyProxyAndImplementation } from './helpers.js';

export async function runVerifyIsm({
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
    getContractFactoryAndName: getIsmFactoryAndName,
  });
}

async function getIsmFactoryAndName(
  multiProvider: MultiProvider,
  chainName: string,
  ismAddress: Address,
): Promise<{
  factory: ContractFactory;
  contractName: string;
}> {
  const warpRouteReader = new EvmIsmReader(multiProvider, chainName);
  const ismConfig = await warpRouteReader.deriveIsmConfig(ismAddress);
  const ismType = ismConfig.type;

  const factory = objFilter(
    ismFactories,
    (t, _contract): _contract is any => t === ismType,
  )[ismType];

  const contractName = ismContracts[ismType];
  return { factory, contractName };
}
