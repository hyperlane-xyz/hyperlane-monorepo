import { HelloWorldConfig } from '../../../src/config';

import { MainnetChains, environment } from './chains';
import helloWorldAddresses from './helloworld/addresses.json';

export const helloWorld: HelloWorldConfig<MainnetChains> = {
  addresses: helloWorldAddresses,
  kathy: {
    docker: {
      repo: 'gcr.io/abacus-labs-dev/abacus-monorepo',
      tag: 'sha-f0c45a1',
    },
    cronSchedule: '0 */6 * * *', // Once every 6 hours
    chainsToSkip: [],
    runEnv: environment,
    namespace: environment,
    prometheusPushGateway:
      'http://prometheus-pushgateway.monitoring.svc.cluster.local:9091',
  },
};
