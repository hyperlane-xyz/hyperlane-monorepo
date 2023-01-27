import { ConnectionType } from '../../../src/config/agent';
import { LiquidityLayerRelayerConfig } from '../../../src/config/middleware';

import { environment } from './chains';

export const liquidityLayerRelayerConfig: LiquidityLayerRelayerConfig = {
  docker: {
    repo: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
    tag: 'sha-437f701',
  },
  namespace: environment,
  prometheusPushGateway:
    'http://prometheus-pushgateway.monitoring.svc.cluster.local:9091',
  connectionType: ConnectionType.Http,
};
