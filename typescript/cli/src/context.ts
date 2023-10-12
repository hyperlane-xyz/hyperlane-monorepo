import { ethers } from 'ethers';

import {
  ChainMap,
  ChainMetadata,
  HyperlaneContractsMap,
  MultiProvider,
  chainMetadata,
  hyperlaneEnvironments,
} from '@hyperlane-xyz/sdk';
import { objMerge } from '@hyperlane-xyz/utils';

import { readChainConfigIfExists } from './config/chain.js';
import { keyToSigner } from './utils/keys.js';

export const sdkContractAddressesMap = {
  ...hyperlaneEnvironments.testnet,
  ...hyperlaneEnvironments.mainnet,
};

export function getMergedContractAddresses(
  artifacts?: HyperlaneContractsMap<any>,
) {
  return objMerge(
    sdkContractAddressesMap,
    artifacts || {},
  ) as HyperlaneContractsMap<any>;
}

export function getContext(chainConfigPath: string) {
  const customChains = readChainConfigIfExists(chainConfigPath);
  const multiProvider = getMultiProvider(customChains);
  return { customChains, multiProvider };
}

export function getContextWithSigner(key: string, chainConfigPath: string) {
  const signer = keyToSigner(key);
  const customChains = readChainConfigIfExists(chainConfigPath);
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
