import { IRegistry } from '@hyperlane-xyz/registry';
import { ChainMap, ChainMetadata, ChainName } from '@hyperlane-xyz/sdk';
import { getRegistryForEnvironment } from '../../../src/config/chain.js';
import {
  getRegistry as getBaseRegistry,
  isChainPresentInRegistry,
} from '../../../config/registry.js';
import { isEthereumProtocolChain } from '../../../src/utils/utils.js';

import { supportedChainNames } from './supportedChainNames.js';

export const environment = 'testnet4';

const baseRegistry = getBaseRegistry();

export const supportedChainNamesInRegistry = supportedChainNames.filter(
  (chainName) => isChainPresentInRegistry(baseRegistry, environment, chainName),
);

export const ethereumChainNames = supportedChainNamesInRegistry.filter(
  isEthereumProtocolChain,
);

// Chains without CoinGecko listings - these won't be overwritten by print-token-prices.ts
export const tokenPriceOverrides: ChainMap<string> = {};

export const chainMetadataOverrides: ChainMap<Partial<ChainMetadata>> = {
  bsctestnet: {
    transactionOverrides: {
      gasPrice: 1 * 10 ** 9, // 1 gwei
    },
  },
  hyperliquidevmtestnet: {
    blocks: {
      confirmations: 1,
      reorgPeriod: 5,
    },
  },
  kyvetestnet: {
    transactionOverrides: {
      gasPrice: '2.0',
    },
  },
};

export const getRegistry = async (
  useSecrets = true,
  chains: ChainName[] = supportedChainNamesInRegistry,
): Promise<IRegistry> =>
  getRegistryForEnvironment(
    environment,
    chains,
    chainMetadataOverrides,
    useSecrets,
  );
