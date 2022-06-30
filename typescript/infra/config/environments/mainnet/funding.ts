import { RelayerFunderConfig } from '../../../src/config/funding';

import { environment } from './chains';

export const relayerFunderConfig: RelayerFunderConfig = {
  docker: {
    repo: 'gcr.io/abacus-labs-dev/abacus-monorepo',
    tag: 'sha-f1e5fb5',
  },
  cronSchedule: '*/10 * * * *',
  namespace: environment,
};
