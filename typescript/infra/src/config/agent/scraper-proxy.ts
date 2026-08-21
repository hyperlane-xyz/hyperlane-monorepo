import type { DockerConfig, KubernetesResources } from './agent.js';

export interface ScraperProxyConfig {
  docker: DockerConfig;
  enabled: boolean;
  port?: number;
  resources?: KubernetesResources;
  tunnel?: { image: string };
}

export type HelmScraperProxyValues = Omit<ScraperProxyConfig, 'docker'>;
