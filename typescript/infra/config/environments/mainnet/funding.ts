import { RelayerFunderConfig } from '../../../src/config/funding';
import { Contexts } from '../../contexts';

import { environment } from './chains';

export const relayerFunderConfig: RelayerFunderConfig = {
  docker: {
    repo: 'gcr.io/abacus-labs-dev/abacus-monorepo',
    tag: 'sha-d24eaa4',
  },
  cronSchedule: '45 * * * *', // Every hour at the 45 minute mark
  namespace: environment,
  prometheusPushGateway:
    'http://prometheus-pushgateway.monitoring.svc.cluster.local:9091',
  contextFundingFrom: Contexts.Abacus,
  contextsToFund: [Contexts.Abacus],
};
