import { RelayerFunderConfig } from '../../../src/config/funding';

import { environment } from './chains';

export const relayerFunderConfig: RelayerFunderConfig = {
  docker: {
    repo: 'gcr.io/abacus-labs-dev/abacus-monorepo',
    tag: 'sha-de2ffbd',
  },
  cronSchedule: '*/10 * * * *', // Every 10 minutes
  namespace: environment,
};
