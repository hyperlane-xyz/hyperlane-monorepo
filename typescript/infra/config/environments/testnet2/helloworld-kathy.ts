import { HelloWorldKathyConfig } from '../../../src/config';

import { TestnetChains, chainNames, environment } from './common';

export const helloWorldKathyConfig: HelloWorldKathyConfig<TestnetChains> = {
  docker: {
    repo: 'gcr.io/abacus-labs-dev/abacus-monorepo',
    tag: 'sha-xxxx',
  },
  runEnv: environment,
  namespace: environment,
  chains: chainNames,
};
