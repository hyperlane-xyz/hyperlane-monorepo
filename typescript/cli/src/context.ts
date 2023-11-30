import { ethers } from 'ethers';

import {
  ChainMap,
  ChainMetadata,
  ChainName,
  HyperlaneContractsMap,
  MultiProvider,
  chainMetadata,
  hyperlaneEnvironments,
} from '@hyperlane-xyz/sdk';
import { objFilter, objMap, objMerge } from '@hyperlane-xyz/utils';

import { readChainConfigsIfExists } from './config/chain.js';
import { keyToSigner } from './utils/keys.js';

export const sdkContractAddressesMap: HyperlaneContractsMap<any> = {
  ...hyperlaneEnvironments.testnet,
  ...hyperlaneEnvironments.mainnet,
};

export function getMergedContractAddresses(
  artifacts?: HyperlaneContractsMap<any>,
  chains?: ChainName[],
) {
  // if chains include non sdkContractAddressesMap chains, don't recover interchainGasPaymaster
  let sdkContractsAddressesToRecover = sdkContractAddressesMap;
  if (
    chains?.some(
      (chain) => !Object.keys(sdkContractAddressesMap).includes(chain),
    )
  ) {
    sdkContractsAddressesToRecover = objMap(sdkContractAddressesMap, (_, v) =>
      objFilter(
        v as ChainMap<any>,
        (key, v): v is any => key !== 'interchainGasPaymaster',
      ),
    );
  }
  return objMerge(
    sdkContractsAddressesToRecover,
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
