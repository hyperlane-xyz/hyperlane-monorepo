import { IRegistry } from '@hyperlane-xyz/registry';
import { ChainMap, ChainMetadata } from '@hyperlane-xyz/sdk';

import { getRegistryForEnvironment } from '../../../src/config/chain.js';
import { isEthereumProtocolChain } from '../../../src/utils/utils.js';

import { supportedChainNames } from './supportedChainNames.js';

export const environment = 'testnet4';

export const ethereumChainNames = supportedChainNames.filter(
  isEthereumProtocolChain,
);

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

  // deploy-only overrides
  // scrollsepolia: {
  //   transactionOverrides: {
  //     gasPrice: 0.5 * 10 ** 9, // 0.5 gwei
  //   },
  // },
  // somniatestnet: {
  //   transactionOverrides: {
  //     gasLimit: 10000000,
  //   },
  // },
  // infinityvmmonza: {
  //   transactionOverrides: {
  //     gasLimit: 10000000,
  //   },
  // },
};

export const getRegistry = async (useSecrets = true): Promise<IRegistry> =>
  getRegistryForEnvironment(
    environment,
    supportedChainNames,
    chainMetadataOverrides,
    useSecrets,
  );
