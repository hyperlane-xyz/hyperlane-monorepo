import { RpcConsensusType } from '@hyperlane-xyz/sdk';

import { DockerConfig } from './agent/agent.js';

export interface LiquidityLayerRelayerConfig {
  docker: DockerConfig;
  namespace: string;
  prometheusPushGateway: string;
}
