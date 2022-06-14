import { chainConnectionConfigs } from '@abacus-network/sdk';

export const mainnetConfigs = {
  celo: chainConnectionConfigs.celo,
  ethereum: chainConnectionConfigs.ethereum,
  avalanche: chainConnectionConfigs.avalanche,
  polygon: chainConnectionConfigs.polygon,
  bsc: chainConnectionConfigs.bsc,
  arbitrum: chainConnectionConfigs.arbitrum,
  optimism: chainConnectionConfigs.optimism,
};

export type MainnetChains = keyof typeof mainnetConfigs;
export const chainNames = Object.keys(mainnetConfigs) as MainnetChains[];
