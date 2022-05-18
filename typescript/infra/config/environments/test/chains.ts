import { configs } from '../../networks/testnets';

export const testConfigs = {
  test1: configs.test1,
  test2: configs.test2,
  test3: configs.test3,
};

export type TestChains = keyof typeof testConfigs;
export const chainNames = Object.keys(testConfigs) as TestChains[];
