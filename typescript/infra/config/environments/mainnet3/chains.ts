import { IRegistry } from '@hyperlane-xyz/registry';
import { ChainMap, ChainMetadata, ChainName } from '@hyperlane-xyz/sdk';

import { getRegistryForEnvironment } from '../../../src/config/chain.js';
import { isEthereumProtocolChain } from '../../../src/utils/utils.js';

import { supportedChainNames } from './supportedChainNames.js';

export const environment = 'mainnet3';

export const ethereumChainNames = supportedChainNames.filter(
  isEthereumProtocolChain,
);

// Agent specific chain metadata overrides
// Such as minGasPrice, minFeePerGas, minPriorityFeePerGas
export const agentSpecificChainMetadataOverrides: ChainMap<
  Partial<ChainMetadata>
> = {
  incentiv: {
    transactionOverrides: {
      minGasPrice: 1 * 10 ** 9, // 1 gwei
      minFeePerGas: 1 * 10 ** 9, // 1 gwei
      minPriorityFeePerGas: 1 * 10 ** 9, // 1 gwei
    },
  },
  ronin: {
    transactionOverrides: {
      minGasPrice: 20 * 10 ** 9, // 20 gwei
      minFeePerGas: 20 * 10 ** 9, // 20 gwei
      minPriorityFeePerGas: 20 * 10 ** 9, // 20 gwei
    },
  },
  ink: {
    transactionOverrides: {
      minGasPrice: 1, // 1 wei
      minFeePerGas: 1, // 1 wei
      minPriorityFeePerGas: 1, // 1 wei
    },
  },
  krown: {
    transactionOverrides: {
      minGasPrice: 11 * 10 ** 5,
      minFeePerGas: 11 * 10 ** 5,
      minPriorityFeePerGas: 11 * 10 ** 5,
    },
  },
};

export const chainMetadataOverrides: ChainMap<Partial<ChainMetadata>> = {
  kyve: {
    gasPrice: {
      amount: '63.0',
      denom: 'ukyve',
    },
  },
  noble: {
    gasPrice: {
      amount: '0.1',
      denom: 'uusdn',
    },
  },
  bsc: {
    transactionOverrides: {
      gasPrice: 1 * 10 ** 8, // 0.1 gwei
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
  morph: {
    transactionOverrides: {
      gasPrice: 1 * 10 ** 6, // 0.001 gwei
    },
  },
  // Deploy-only overrides, set when deploying contracts
  // chilizmainnet: {
  //   transactionOverrides: {
  //     maxFeePerGas: 100000 * 10 ** 9, // 100,000 gwei
  //     maxPriorityFeePerGas: 100000 * 10 ** 9, // 100,000 gwei
  //   },
  // },
  // xlayer: {
  //   blocks: {
  //     confirmations: 5,
  //   },
  // },
  // soneium: {
  //   blocks: {
  //     confirmations: 3,
  //   },
  // },
  // flowmainnet: {
  //   blocks: {
  //     confirmations: 3,
  //   },
  // },
};

export const getRegistry = async (
  useSecrets = true,
  chains: ChainName[] = supportedChainNames,
): Promise<IRegistry> =>
  getRegistryForEnvironment(
    environment,
    chains,
    chainMetadataOverrides,
    useSecrets,
  );
