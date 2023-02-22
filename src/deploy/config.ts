import { RouterConfig, chainMetadata } from '@hyperlane-xyz/sdk';

export type HelloWorldConfig = RouterConfig;

// SET DESIRED NETWORKS HERE
export const prodConfigs = {
  alfajores: chainMetadata.alfajores,
};
