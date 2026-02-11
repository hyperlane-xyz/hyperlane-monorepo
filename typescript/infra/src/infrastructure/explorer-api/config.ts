/**
 * Configuration types for the Explorer API infrastructure
 */

export interface CloudSqlConfig {
  /** GCP project ID */
  projectId: string;
  /** GCP region for the Cloud SQL instance */
  region: string;
  /** Instance name */
  instanceName: string;
  /** Database name */
  databaseName: string;
  /** Database tier (machine type) */
  tier: string;
  /** Disk size in GB */
  diskSizeGb: number;
  /** Whether to enable high availability */
  highAvailability: boolean;
  /** Authorized networks for database access */
  authorizedNetworks: Array<{
    name: string;
    value: string;
  }>;
  /** Whether to enable private IP */
  privateIpEnabled: boolean;
  /** VPC network for private IP (if enabled) */
  vpcNetwork?: string;
  /** Maintenance window */
  maintenanceWindow?: {
    day: number; // 1-7 (Mon-Sun)
    hour: number; // 0-23
  };
  /** Backup configuration */
  backupConfiguration?: {
    enabled: boolean;
    startTime: string; // HH:MM format
    retainedBackups: number;
    pointInTimeRecoveryEnabled: boolean;
  };
}

export interface HasuraConfig {
  /** Kubernetes namespace for Hasura deployment */
  namespace: string;
  /** Hasura release name */
  releaseName: string;
  /** Hasura image tag */
  imageTag: string;
  /** Number of replicas */
  replicas: number;
  /** Resource limits */
  resources: {
    requests: {
      cpu: string;
      memory: string;
    };
    limits: {
      cpu: string;
      memory: string;
    };
  };
  /** Hasura admin secret (will be stored in K8s secret) */
  adminSecretName: string;
  /** Whether to enable console */
  enableConsole: boolean;
  /** Whether to enable introspection */
  enableIntrospection: boolean;
  /** Cache TTL in seconds */
  cacheTtl: number;
  /** PostgreSQL connection secret name */
  dbConnectionSecretName: string;
}

export interface ExplorerApiConfig {
  /** Environment name (e.g., mainnet3, testnet4) */
  environment: string;
  /** Cloud SQL configuration */
  cloudSql: CloudSqlConfig;
  /** Hasura configuration */
  hasura: HasuraConfig;
}

/**
 * Default configuration for mainnet3 environment
 */
export const mainnet3ExplorerApiConfig: ExplorerApiConfig = {
  environment: 'mainnet3',
  cloudSql: {
    projectId: 'hyperlane-mainnet',
    region: 'us-east1',
    instanceName: 'explorer-api-mainnet3',
    databaseName: 'explorer',
    tier: 'db-custom-4-16384', // 4 vCPUs, 16 GB RAM
    diskSizeGb: 100,
    highAvailability: true,
    authorizedNetworks: [],
    privateIpEnabled: true,
    vpcNetwork: 'projects/hyperlane-mainnet/global/networks/default',
    maintenanceWindow: {
      day: 7, // Sunday
      hour: 4, // 4 AM UTC
    },
    backupConfiguration: {
      enabled: true,
      startTime: '03:00',
      retainedBackups: 7,
      pointInTimeRecoveryEnabled: true,
    },
  },
  hasura: {
    namespace: 'explorer-api',
    releaseName: 'hasura-explorer',
    imageTag: 'v2.36.0',
    replicas: 2,
    resources: {
      requests: {
        cpu: '500m',
        memory: '512Mi',
      },
      limits: {
        cpu: '2000m',
        memory: '2Gi',
      },
    },
    adminSecretName: 'hasura-admin-secret',
    enableConsole: false,
    enableIntrospection: false,
    cacheTtl: 5,
    dbConnectionSecretName: 'hasura-db-connection',
  },
};

/**
 * Default configuration for testnet4 environment
 */
export const testnet4ExplorerApiConfig: ExplorerApiConfig = {
  environment: 'testnet4',
  cloudSql: {
    projectId: 'hyperlane-testnet',
    region: 'us-east1',
    instanceName: 'explorer-api-testnet4',
    databaseName: 'explorer',
    tier: 'db-custom-2-8192', // 2 vCPUs, 8 GB RAM
    diskSizeGb: 50,
    highAvailability: false,
    authorizedNetworks: [],
    privateIpEnabled: true,
    vpcNetwork: 'projects/hyperlane-testnet/global/networks/default',
    maintenanceWindow: {
      day: 7,
      hour: 4,
    },
    backupConfiguration: {
      enabled: true,
      startTime: '03:00',
      retainedBackups: 3,
      pointInTimeRecoveryEnabled: false,
    },
  },
  hasura: {
    namespace: 'explorer-api',
    releaseName: 'hasura-explorer',
    imageTag: 'v2.36.0',
    replicas: 1,
    resources: {
      requests: {
        cpu: '250m',
        memory: '256Mi',
      },
      limits: {
        cpu: '1000m',
        memory: '1Gi',
      },
    },
    adminSecretName: 'hasura-admin-secret',
    enableConsole: true,
    enableIntrospection: false,
    cacheTtl: 5,
    dbConnectionSecretName: 'hasura-db-connection',
  },
};

/**
 * Get configuration for a specific environment
 */
export function getExplorerApiConfig(
  environment: string,
): ExplorerApiConfig | undefined {
  switch (environment) {
    case 'mainnet3':
      return mainnet3ExplorerApiConfig;
    case 'testnet4':
      return testnet4ExplorerApiConfig;
    default:
      return undefined;
  }
}
