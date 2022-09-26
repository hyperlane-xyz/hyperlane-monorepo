import { chainConnectionConfigs } from '@hyperlane-xyz/sdk';

export const testConfigs = {
  test1: chainConnectionConfigs.test1,
  test2: chainConnectionConfigs.test2,
  test3: chainConnectionConfigs.test3,
};

export type TestChains = keyof typeof testConfigs;
export const chainNames = Object.keys(testConfigs) as TestChains[];
