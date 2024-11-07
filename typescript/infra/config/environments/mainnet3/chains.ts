import { IRegistry } from '@hyperlane-xyz/registry';
import { ChainMap, ChainMetadata } from '@hyperlane-xyz/sdk';

import { getRegistryForEnvironment } from '../../../src/config/chain.js';
import { isEthereumProtocolChain } from '../../../src/utils/utils.js';

import { supportedChainNames } from './supportedChainNames.js';

export const environment = 'mainnet3';

export const ethereumChainNames = supportedChainNames.filter(
  isEthereumProtocolChain,
);

export const chainMetadataOverrides: ChainMap<Partial<ChainMetadata>> = {
  bsc: {
    transactionOverrides: {
      gasPrice: 3 * 10 ** 9, // 3 gwei
    },
  },
  polygon: {
    transactionOverrides: {
      // A very high max fee per gas is used as Polygon is susceptible
      // to large swings in gas prices.
      maxFeePerGas: 800 * 10 ** 9, // 800 gwei
      maxPriorityFeePerGas: 50 * 10 ** 9, // 50 gwei
    },
  },
  polygonzkevm: {
    transactionOverrides: {
      gasPrice: 1 * 10 ** 9, // 1 gwei
    },
  },
  scroll: {
    transactionOverrides: {
      // Scroll doesn't use EIP 1559 and the gas price that's returned is sometimes
      // too low for the transaction to be included in a reasonable amount of time -
      // this often leads to transaction underpriced issues.
      gasPrice: 2 * 10 ** 8, // 0.2 gwei
    },
  },
  sei: {
    // Sei's `eth_feeHistory` is not to spec and incompatible with ethers-rs,
    // so we force legacy transactions by setting a gas price.
    // A minimum fee of 100 gwei is imposed https://seitrace.com/proposal/83?chain=pacific-1
    transactionOverrides: {
      gasPrice: 101 * 10 ** 9, // 101 gwei
    },
  },
  moonbeam: {
    transactionOverrides: {
      maxFeePerGas: 350 * 10 ** 9, // 350 gwei
      maxPriorityFeePerGas: 50 * 10 ** 9, // 50 gwei
    },
  },
  rootstockmainnet: {
    transactionOverrides: {
      gasPrice: 7 * 10 ** 7, // 0.07 gwei
      // gasLimit: 6800000, // set when deploying contracts
    },
  },
  // Deploy-only overrides, set when deploying contracts
  // chilizmainnet: {
  //   transactionOverrides: {
  //     maxFeePerGas: 100000 * 10 ** 9, // 100,000 gwei
  //   },
  // },
  // zircuit: {
  //   blocks: {
  //     confirmations: 3,
  //   },
  // },
  // prom: {
  //   transactionOverrides: {
  //     gasPrice: 20 * 10 ** 9, // 20 gwei
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
