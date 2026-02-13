import type {
  HelmChartConfig,
  HelmChartRepositoryConfig,
} from '../../config/infrastructure.js';

export const HASURA_HELM_REPOSITORY: HelmChartRepositoryConfig = {
  name: 'hasura',
  url: 'https://hasura.github.io/helm-charts',
};

export const HASURA_HELM_CHART: HelmChartConfig = {
  name: 'graphql-engine',
  version: '0.9.1',
  repository: HASURA_HELM_REPOSITORY,
};

export interface HasuraTrackedTable {
  schema: string;
  name: string;
}

export interface HasuraExplorerConfig {
  /** Kubernetes namespace */
  namespace: string;
  /** Helm release name */
  releaseName: string;
  /** Hasura image tag */
  imageTag: string;
  /** Number of replicas */
  replicas: number;
  /** Resource requests/limits */
  resources: {
    requests: { cpu: string; memory: string };
    limits: { cpu: string; memory: string };
  };
  /** GCP Secret Manager secret name containing the DB connection string */
  dbConnectionSecretName: string;
  /** GCP Secret Manager secret name containing the Hasura admin secret */
  adminSecretName: string;
  /** Whether to enable console */
  enableConsole: boolean;
  /** Cache TTL in seconds for @cached directive */
  cacheTtl: number;
  /** Tables/views to track in Hasura (string = public schema shorthand) */
  trackedTables: (string | HasuraTrackedTable)[];
}

/** Tables that need to be tracked in Hasura for the Explorer API */
export const EXPLORER_TRACKED_TABLES = [
  'domain',
  'message_view',
  'raw_message_dispatch',
];

export const mainnet3HasuraConfig: HasuraExplorerConfig = {
  namespace: 'explorer-api',
  releaseName: 'hasura-explorer',
  imageTag: 'v2.36.0',
  replicas: 2,
  resources: {
    requests: { cpu: '500m', memory: '512Mi' },
    limits: { cpu: '2000m', memory: '2Gi' },
  },
  dbConnectionSecretName: 'hyperlane-mainnet3-scraper3-db',
  adminSecretName: 'hyperlane-mainnet3-hasura-admin-secret',
  enableConsole: false,
  cacheTtl: 5,
  trackedTables: EXPLORER_TRACKED_TABLES,
};

export const testnet4HasuraConfig: HasuraExplorerConfig = {
  namespace: 'explorer-api',
  releaseName: 'hasura-explorer',
  imageTag: 'v2.36.0',
  replicas: 1,
  resources: {
    requests: { cpu: '250m', memory: '256Mi' },
    limits: { cpu: '1000m', memory: '1Gi' },
  },
  dbConnectionSecretName: 'hyperlane-testnet4-scraper3-db',
  adminSecretName: 'hyperlane-testnet4-hasura-admin-secret',
  enableConsole: true,
  cacheTtl: 5,
  trackedTables: EXPLORER_TRACKED_TABLES,
};

export function getHasuraExplorerConfig(
  environment: string,
): HasuraExplorerConfig {
  switch (environment) {
    case 'mainnet3':
      return mainnet3HasuraConfig;
    case 'testnet4':
      return testnet4HasuraConfig;
    default:
      throw new Error(`No Explorer API config for environment: ${environment}`);
  }
}
