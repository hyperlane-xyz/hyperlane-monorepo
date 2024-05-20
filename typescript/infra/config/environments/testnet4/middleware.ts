import { RpcConsensusType } from '@hyperlane-xyz/sdk';

import { LiquidityLayerRelayerConfig } from '../../../src/config/middleware.js';

import { environment } from './chains.js';

export const liquidityLayerRelayerConfig: LiquidityLayerRelayerConfig = {
  docker: {
    repo: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
    tag: 'sha-437f701',
  },
  namespace: environment,
  prometheusPushGateway:
    'http://prometheus-prometheus-pushgateway.monitoring.svc.cluster.local:9091',
  connectionType: RpcConsensusType.Single,
};
