/**
 * Hasura GraphQL Engine deployment on GKE using Pulumi + Helm
 *
 * This module deploys Hasura CE on Kubernetes using the official Hasura Helm chart
 * from https://hasura.github.io/helm-charts (chart: graphql-engine).
 *
 * Configuration includes:
 * - Anonymous read-only access
 * - Mutations disabled
 * - Introspection disabled
 * - @cached(ttl: 5) support
 */

import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

import type { HasuraConfig } from './config.js';
import { HASURA_TRACKED_TABLES } from './cloudsql.js';

/**
 * Official Hasura Helm chart repository configuration.
 * @see https://github.com/hasura/helm-charts/tree/main/charts/graphql-engine
 */
export const HASURA_HELM_REPO = {
  name: 'hasura',
  url: 'https://hasura.github.io/helm-charts',
};

export const HASURA_HELM_CHART = {
  name: 'graphql-engine',
  version: '1.4.0',
  repo: HASURA_HELM_REPO.url,
};

export interface HasuraDeploymentOutputs {
  /** The Helm release */
  release: k8s.helm.v3.Release;
  /** The Kubernetes service */
  service: k8s.core.v1.Service;
  /** The service URL */
  serviceUrl: pulumi.Output<string>;
}

/**
 * Hasura metadata configuration for tracking tables and setting permissions
 */
export interface HasuraMetadata {
  version: number;
  sources: HasuraSource[];
}

export interface HasuraSource {
  name: string;
  kind: string;
  tables: HasuraTable[];
  configuration: {
    connection_info: {
      database_url: { from_env: string };
      pool_settings: {
        max_connections: number;
        idle_timeout: number;
        retries: number;
      };
    };
  };
}

export interface HasuraTable {
  table: { schema: string; name: string };
  select_permissions?: HasuraSelectPermission[];
  configuration?: {
    custom_root_fields?: {
      select?: string;
      select_aggregate?: string;
      select_by_pk?: string;
    };
  };
}

export interface HasuraSelectPermission {
  role: string;
  permission: {
    columns: string[] | '*';
    filter: Record<string, unknown>;
    allow_aggregations: boolean;
    query_root_fields?: string[];
  };
}

/**
 * Creates the Hasura namespace
 */
export function createHasuraNamespace(
  namespace: string,
  provider?: k8s.Provider,
): k8s.core.v1.Namespace {
  return new k8s.core.v1.Namespace(
    namespace,
    {
      metadata: {
        name: namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'pulumi',
          'app.kubernetes.io/part-of': 'explorer-api',
        },
      },
    },
    { provider },
  );
}

/**
 * Creates the Kubernetes secret for Hasura database connection
 */
export function createHasuraDbSecret(
  config: HasuraConfig,
  dbConnectionString: pulumi.Input<string>,
  provider?: k8s.Provider,
): k8s.core.v1.Secret {
  return new k8s.core.v1.Secret(
    config.dbConnectionSecretName,
    {
      metadata: {
        name: config.dbConnectionSecretName,
        namespace: config.namespace,
      },
      type: 'Opaque',
      stringData: {
        HASURA_GRAPHQL_DATABASE_URL: dbConnectionString,
      },
    },
    { provider },
  );
}

/**
 * Creates the Kubernetes secret for Hasura admin access
 */
export function createHasuraAdminSecret(
  config: HasuraConfig,
  adminSecret: pulumi.Input<string>,
  provider?: k8s.Provider,
): k8s.core.v1.Secret {
  return new k8s.core.v1.Secret(
    config.adminSecretName,
    {
      metadata: {
        name: config.adminSecretName,
        namespace: config.namespace,
      },
      type: 'Opaque',
      stringData: {
        HASURA_GRAPHQL_ADMIN_SECRET: adminSecret,
      },
    },
    { provider },
  );
}

/**
 * Deploys Hasura using the official Helm chart from https://hasura.github.io/helm-charts
 *
 * @param config - Hasura configuration
 * @param dbSecret - Kubernetes secret containing database connection string
 * @param adminSecret - Kubernetes secret containing admin secret
 * @param provider - Kubernetes provider
 * @returns Helm release and service outputs
 */
export function deployHasura(
  config: HasuraConfig,
  dbSecret: k8s.core.v1.Secret,
  adminSecret: k8s.core.v1.Secret,
  provider?: k8s.Provider,
): HasuraDeploymentOutputs {
  // Values for the official Hasura graphql-engine chart
  // @see https://github.com/hasura/helm-charts/blob/main/charts/graphql-engine/values.yaml
  const hasuraValues = {
    // Image configuration
    image: {
      repository: 'hasura/graphql-engine',
      tag: config.imageTag,
      pullPolicy: 'IfNotPresent',
    },

    // Replica count
    replicaCount: config.replicas,

    // Resource configuration
    resources: config.resources,

    // Hasura-specific configuration (official chart structure)
    hasura: {
      // Database connection - use existing secret
      adminSecret: {
        existingSecret: config.adminSecretName,
        key: 'HASURA_GRAPHQL_ADMIN_SECRET',
      },
      dbUrl: {
        existingSecret: config.dbConnectionSecretName,
        key: 'HASURA_GRAPHQL_DATABASE_URL',
      },
      // Console configuration
      enableConsole: config.enableConsole,
      // Dev mode disabled for production
      devMode: false,
      // Disable telemetry
      enableTelemetry: false,
    },

    // Additional environment variables for features not in official chart values
    extraEnv: [
      // Enable anonymous role for read-only access
      { name: 'HASURA_GRAPHQL_UNAUTHORIZED_ROLE', value: 'anonymous' },
      // Introspection configuration (disabled for production)
      {
        name: 'HASURA_GRAPHQL_ENABLE_INTROSPECTION',
        value: config.enableIntrospection ? 'true' : 'false',
      },
      // Enable @cached directive with TTL
      { name: 'HASURA_GRAPHQL_ENABLE_QUERY_CACHING', value: 'true' },
      { name: 'HASURA_GRAPHQL_QUERY_CACHE_TTL', value: String(config.cacheTtl) },
      // Logging
      { name: 'HASURA_GRAPHQL_LOG_LEVEL', value: 'info' },
      // Disable live queries
      { name: 'HASURA_GRAPHQL_ENABLE_LIVE_QUERIES', value: 'false' },
      // Connection pool settings
      { name: 'HASURA_GRAPHQL_PG_CONNECTIONS', value: '50' },
      { name: 'HASURA_GRAPHQL_PG_TIMEOUT', value: '180' },
    ],

    // Service configuration
    service: {
      type: 'ClusterIP',
      port: 8080,
    },

    // Health checks
    livenessProbe: {
      httpGet: {
        path: '/healthz',
        port: 8080,
      },
      initialDelaySeconds: 30,
      periodSeconds: 10,
      failureThreshold: 3,
    },
    readinessProbe: {
      httpGet: {
        path: '/healthz',
        port: 8080,
      },
      initialDelaySeconds: 5,
      periodSeconds: 5,
      failureThreshold: 3,
    },

    // Pod disruption budget for high availability
    podDisruptionBudget: {
      enabled: config.replicas > 1,
      minAvailable: 1,
    },

    // Affinity rules for spreading pods across nodes
    affinity: {
      podAntiAffinity: {
        preferredDuringSchedulingIgnoredDuringExecution: [
          {
            weight: 100,
            podAffinityTerm: {
              labelSelector: {
                matchLabels: {
                  'app.kubernetes.io/name': 'graphql-engine',
                  'app.kubernetes.io/instance': config.releaseName,
                },
              },
              topologyKey: 'kubernetes.io/hostname',
            },
          },
        ],
      },
    },
  };

  // Deploy using official Hasura Helm chart from repository
  const release = new k8s.helm.v3.Release(
    config.releaseName,
    {
      name: config.releaseName,
      namespace: config.namespace,
      chart: HASURA_HELM_CHART.name,
      version: HASURA_HELM_CHART.version,
      repositoryOpts: {
        repo: HASURA_HELM_CHART.repo,
      },
      values: hasuraValues,
      createNamespace: false, // Namespace created separately
      atomic: true,
      timeout: 600, // 10 minutes
    },
    {
      provider,
      dependsOn: [dbSecret, adminSecret],
    },
  );

  // Create service reference - official chart names service as {release}-graphql-engine
  const service = k8s.core.v1.Service.get(
    `${config.releaseName}-service`,
    pulumi.interpolate`${config.namespace}/${config.releaseName}-graphql-engine`,
    { provider },
  );

  const serviceUrl = pulumi.interpolate`http://${config.releaseName}-graphql-engine.${config.namespace}.svc.cluster.local:8080`;

  return {
    release,
    service,
    serviceUrl,
  };
}

/**
 * Generates Hasura metadata for tracking tables with anonymous read-only access
 * This is applied via the Hasura metadata API after deployment
 */
export function generateHasuraMetadata(
  tables: string[] = HASURA_TRACKED_TABLES,
): HasuraMetadata {
  const hasuraTables: HasuraTable[] = tables.map((tableName) => ({
    table: { schema: 'public', name: tableName },
    select_permissions: [
      {
        role: 'anonymous',
        permission: {
          columns: '*',
          filter: {},
          allow_aggregations: true,
          // Only allow select operations (read-only)
          query_root_fields: ['select', 'select_by_pk', 'select_aggregate'],
        },
      },
    ],
  }));

  return {
    version: 3,
    sources: [
      {
        name: 'default',
        kind: 'postgres',
        tables: hasuraTables,
        configuration: {
          connection_info: {
            database_url: { from_env: 'HASURA_GRAPHQL_DATABASE_URL' },
            pool_settings: {
              max_connections: 50,
              idle_timeout: 180,
              retries: 1,
            },
          },
        },
      },
    ],
  };
}

/**
 * Creates a ConfigMap with Hasura metadata for initialization
 * This can be mounted as a volume and applied during Hasura startup
 */
export function createHasuraMetadataConfigMap(
  config: HasuraConfig,
  metadata: HasuraMetadata,
  provider?: k8s.Provider,
): k8s.core.v1.ConfigMap {
  return new k8s.core.v1.ConfigMap(
    `${config.releaseName}-metadata`,
    {
      metadata: {
        name: `${config.releaseName}-metadata`,
        namespace: config.namespace,
      },
      data: {
        'metadata.json': JSON.stringify(metadata, null, 2),
      },
    },
    { provider },
  );
}

/**
 * Creates a Kubernetes Job to apply Hasura metadata
 * This is run after Hasura deployment to configure tables and permissions
 */
export function createMetadataApplyJob(
  config: HasuraConfig,
  hasuraServiceUrl: pulumi.Input<string>,
  adminSecret: pulumi.Input<string>,
  metadataConfigMap: k8s.core.v1.ConfigMap,
  provider?: k8s.Provider,
): k8s.batch.v1.Job {
  return new k8s.batch.v1.Job(
    `${config.releaseName}-apply-metadata`,
    {
      metadata: {
        name: `${config.releaseName}-apply-metadata`,
        namespace: config.namespace,
      },
      spec: {
        ttlSecondsAfterFinished: 600, // Clean up after 10 minutes
        template: {
          spec: {
            restartPolicy: 'OnFailure',
            containers: [
              {
                name: 'apply-metadata',
                image: 'curlimages/curl:latest',
                command: ['/bin/sh', '-c'],
                args: [
                  pulumi.interpolate`
                    # Wait for Hasura to be ready
                    until curl -s ${hasuraServiceUrl}/healthz; do
                      echo "Waiting for Hasura..."
                      sleep 5
                    done

                    # Apply metadata
                    curl -X POST ${hasuraServiceUrl}/v1/metadata \
                      -H "Content-Type: application/json" \
                      -H "X-Hasura-Admin-Secret: ${adminSecret}" \
                      -d @/metadata/metadata.json

                    echo "Metadata applied successfully"
                  `,
                ],
                volumeMounts: [
                  {
                    name: 'metadata',
                    mountPath: '/metadata',
                  },
                ],
              },
            ],
            volumes: [
              {
                name: 'metadata',
                configMap: {
                  name: metadataConfigMap.metadata.name,
                },
              },
            ],
          },
        },
      },
    },
    {
      provider,
      dependsOn: [metadataConfigMap],
    },
  );
}
