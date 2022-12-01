import { ConnectionType, DockerConfig } from './agent';

export interface LiquidityLayerRelayerConfig {
  docker: DockerConfig;
  namespace: string;
  connectionType: ConnectionType.Http | ConnectionType.HttpQuorum;
  prometheusPushGateway: string;
}
