import {
  ChainMap,
  ChainMetadata,
  Chains,
  chainMetadata,
} from '@hyperlane-xyz/sdk';

// All supported chains for the testnet4 environment.
// These chains may be any protocol type.
export const supportedChainNames = [
  Chains.alfajores,
  Chains.bsctestnet,
  Chains.eclipsetestnet,
  Chains.fuji,
  Chains.plumetestnet,
  Chains.scrollsepolia,
  Chains.sepolia,
  Chains.solanatestnet,
];

export const environment = 'testnet4';

export const testnetConfigs: ChainMap<ChainMetadata> = {
  ...Object.fromEntries(
    supportedChainNames.map((chain) => [chain, chainMetadata[chain]]),
  ),
  bsctestnet: {
    ...chainMetadata.bsctestnet,
    transactionOverrides: {
      gasPrice: 8 * 10 ** 9, // 8 gwei
    },
  },
};
