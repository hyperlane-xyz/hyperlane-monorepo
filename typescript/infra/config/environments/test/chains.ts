import { ChainMap, ChainMetadata, chainMetadata } from '@hyperlane-xyz/sdk';

export const testConfigs: ChainMap<ChainMetadata> = {
  test1: chainMetadata.test1,
  test2: chainMetadata.test2,
  test3: chainMetadata.test3,
};

export type TestChains = keyof typeof testConfigs;
export const chainNames = Object.keys(testConfigs) as TestChains[];
