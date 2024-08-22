import { CheckWarpDeployConfig } from '../../../../src/config/funding.js';
import { environment } from '../chains.js';

export const checkWarpDeployConfig: CheckWarpDeployConfig = {
  docker: {
    repo: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
    tag: 'e77dfa7-20240822-113013',
  },
  namespace: environment,
  cronSchedule: '*/5 * * * *',
  prometheusPushGateway:
    'http://prometheus-prometheus-pushgateway.monitoring.svc.cluster.local:9091',
};
