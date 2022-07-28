import { HelloWorldConfig } from '../../../src/config';

import { TestnetChains, environment } from './chains';
import helloWorldAddresses from './helloworld/addresses.json';

export const helloWorld: HelloWorldConfig<TestnetChains> = {
  addresses: helloWorldAddresses,
  kathy: {
    docker: {
      repo: 'gcr.io/abacus-labs-dev/abacus-monorepo',
      tag: 'sha-b33870c',
    },
    cronSchedule: '0 */2 * * *', // Once every 2 hours
    chainsToSkip: [],
    runEnv: environment,
    namespace: environment,
    prometheusPushGateway:
      'http://prometheus-pushgateway.monitoring.svc.cluster.local:9091',
  },
};
