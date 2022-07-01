import { DockerConfig } from './agent';

export interface RelayerFunderConfig {
  docker: DockerConfig;
  cronSchedule: string;
  namespace: string;
}
