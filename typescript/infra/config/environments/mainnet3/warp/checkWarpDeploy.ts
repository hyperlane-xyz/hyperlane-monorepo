import { CheckWarpDeployConfig } from '../../../../src/config/funding.js';
import { environment } from '../chains.js';

export const checkWarpDeployConfig: CheckWarpDeployConfig = {
  docker: {
    repo: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
    tag: '36f7e14-20240823-160646',
  },
  namespace: environment,
  cronSchedule: '0 15 * * *', // set to 3pm utc every day
  prometheusPushGateway:
    'http://prometheus-prometheus-pushgateway.monitoring.svc.cluster.local:9091',
};
