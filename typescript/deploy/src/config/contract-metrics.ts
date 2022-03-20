import { DockerConfig } from './agent';

export interface ContractMetricsConfig {
  namespace: string;
  environment: string;
  docker: DockerConfig;
}
