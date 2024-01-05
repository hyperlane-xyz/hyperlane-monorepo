import { chainMetadata } from '../../consts/chainMetadata';
import { ChainMetadata } from '../../metadata/chainMetadataTypes';
import { ChainMap } from '../../types';

export const testConfigs: ChainMap<ChainMetadata> = {
  test1: chainMetadata.test1,
  test2: chainMetadata.test2,
  test3: chainMetadata.test3,
};

export type TestChains = keyof typeof testConfigs;
export const testChainNames = Object.keys(testConfigs) as TestChains[];
