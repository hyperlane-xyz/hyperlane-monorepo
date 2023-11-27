import { ethers } from 'ethers';

import {
  ChainMap,
  ChainMetadata,
  HyperlaneContractsMap,
  MultiProvider,
  chainMetadata,
  hyperlaneEnvironments,
} from '@hyperlane-xyz/sdk';
import { objFilter, objMapEntries, objMerge } from '@hyperlane-xyz/utils';

import { readChainConfigsIfExists } from './config/chain.js';
import { keyToSigner } from './utils/keys.js';

export const sdkContractAddressesMap = {
  ...hyperlaneEnvironments.testnet,
  ...hyperlaneEnvironments.mainnet,
};

export function getMergedContractAddresses(
  artifacts?: HyperlaneContractsMap<any>,
) {
  return objMerge(
    // filter out interchainGasPaymaster since we don't want to recover it from SDK artifacts
    Object.fromEntries(
      objMapEntries(sdkContractAddressesMap, (k, v) => [
        k,
        objFilter(
          v as ChainMap<any>,
          (key, v): v is any => key !== 'interchainGasPaymaster',
        ),
      ]),
    ),
    artifacts || {},
  ) as HyperlaneContractsMap<any>;
}

export function getContext(chainConfigPath: string) {
  const customChains = readChainConfigsIfExists(chainConfigPath);
  const multiProvider = getMultiProvider(customChains);
  return { customChains, multiProvider };
}

export function getContextWithSigner(key: string, chainConfigPath: string) {
  const signer = keyToSigner(key);
  const customChains = readChainConfigsIfExists(chainConfigPath);
  const multiProvider = getMultiProvider(customChains, signer);
  return { signer, customChains, multiProvider };
}

export function getMultiProvider(
  customChains: ChainMap<ChainMetadata>,
  signer?: ethers.Signer,
) {
  const chainConfigs = { ...chainMetadata, ...customChains };
  const mp = new MultiProvider(chainConfigs);
  if (signer) mp.setSharedSigner(signer);
  return mp;
}
