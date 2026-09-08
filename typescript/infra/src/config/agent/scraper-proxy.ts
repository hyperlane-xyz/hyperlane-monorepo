import type { DockerConfig, KubernetesResources } from './agent.js';

type ScraperProxyTunnelConfig =
  | { enabled: false; image?: never }
  | { enabled: true; image: string };

export interface ScraperProxyConfig {
  docker: DockerConfig;
  enabled: boolean;
  port?: number;
  replicas?: number;
  resources?: KubernetesResources;
  tunnel?: ScraperProxyTunnelConfig;
}

export type HelmScraperProxyValues = Omit<ScraperProxyConfig, 'docker'>;
