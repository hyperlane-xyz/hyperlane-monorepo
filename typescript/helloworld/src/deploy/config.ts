import { RouterConfig, chainConnectionConfigs } from '@abacus-network/sdk';

export type HelloWorldConfig = RouterConfig;

export const testConfigs = {
  test1: chainConnectionConfigs.test1,
  test2: chainConnectionConfigs.test2,
  test3: chainConnectionConfigs.test3,
};

// SET DESIRED NETWORKS HERE
export const prodConfigs = {
  alfajores: chainConnectionConfigs.alfajores,
};
