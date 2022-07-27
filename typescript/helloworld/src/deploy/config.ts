import { RouterConfig, chainConnectionConfigs } from '@abacus-network/sdk';

export type HelloWorldConfig = RouterConfig;

// SET DESIRED NETWORKS HERE
export const prodConfigs = {
  alfajores: chainConnectionConfigs.alfajores,
};
