import {
  chainConnectionConfigs,
  ChainMap,
  TestChainNames,
  RouterConfig,
} from '@abacus-network/sdk';

export type HelloWorldConfig = RouterConfig;

// TODO reduce this config boilerplate

export const testConfigs = {
  test1: chainConnectionConfigs.test1,
  test2: chainConnectionConfigs.test2,
  test3: chainConnectionConfigs.test3,
};

export function getConfigMap(
  signerAddress: string,
): ChainMap<TestChainNames, { owner: string }> {
  return {
    test1: {
      owner: signerAddress,
    },
    test2: {
      owner: signerAddress,
    },
    test3: {
      owner: signerAddress,
    },
  };
}
