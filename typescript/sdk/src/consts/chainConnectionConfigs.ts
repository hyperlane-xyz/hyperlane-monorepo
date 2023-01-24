import { ethers } from 'ethers';

import { StaticCeloJsonRpcProvider } from '@hyperlane-xyz/celo-ethers-provider';

import { ChainMap, ChainName, IChainConnection } from '../types';
import { objMap } from '../utils/objects';

import { chainMetadata, test1, test2, test3 } from './chainMetadata';
import { Chains, TestChains } from './chains';

function testChainConnection(id: number) {
  return {
    id,
    provider: new ethers.providers.JsonRpcProvider(
      'http://localhost:8545',
      31337,
    ),
    confirmations: 1,
  };
}

export const chainConnectionConfigs: ChainMap<ChainName, IChainConnection> =
  objMap(chainMetadata, (chainName, metadata) => {
    if (TestChains.includes(chainName)) return testChainConnection(metadata.id);

    const providerClass =
      chainName === Chains.alfajores || chainName === Chains.celo
        ? StaticCeloJsonRpcProvider
        : ethers.providers.JsonRpcProvider;

    return {
      id: metadata.id,
      provider: new providerClass(metadata.publicRpcUrls[0].http, metadata.id),
      confirmations: metadata.blocks.confirmations,
      blockExplorerUrl: metadata.blockExplorers[0].url,
      blockExplorerApiUrl: metadata.blockExplorers[0].apiUrl,
    };
  });

export const testChainConnectionConfigs = {
  test1: testChainConnection(test1.id),
  test2: testChainConnection(test2.id),
  test3: testChainConnection(test3.id),
};
