import { ethers } from 'ethers';

import {
  ChainMap,
  ChainMetadata,
  MultiProvider,
  chainMetadata,
  hyperlaneEnvironments,
} from '@hyperlane-xyz/sdk';

import { readChainConfigIfExists } from './configs.js';
import { keyToSigner } from './utils/keys.js';

export const sdkContractAddressesMap = {
  ...hyperlaneEnvironments.testnet,
  ...hyperlaneEnvironments.mainnet,
};

export function getDeployerContext(key: string, chainConfigPath: string) {
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
