import { chainConnectionConfigs } from '@abacus-network/sdk';

export const testnetConfigs = {
  alfajores: chainConnectionConfigs.alfajores,
  kovan: chainConnectionConfigs.kovan,
};

export type TestnetChains = keyof typeof testnetConfigs;
export const chainNames = Object.keys(testnetConfigs) as TestnetChains[];
