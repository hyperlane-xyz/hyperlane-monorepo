import { RelayerFunderConfig } from '../../../src/config/funding';

import { environment } from './chains';

export const relayerFunderConfig: RelayerFunderConfig = {
  docker: {
    repo: 'gcr.io/abacus-labs-dev/abacus-monorepo',
    tag: 'sha-5d8d3f1',
  },
  cronSchedule: '*/10 * * * *', // Every 10 minutes
  namespace: environment,
};
