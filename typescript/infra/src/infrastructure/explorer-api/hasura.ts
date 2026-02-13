/**
 * Deploys Hasura GraphQL Engine on GKE using the official Hasura Helm chart.
 *
 * Uses the existing Cloud SQL instance (pgsql-message-explorer-0) that the
 * scraper already writes to. DB connection string is fetched from GCP Secret
 * Manager at deploy time.
 *
 * Follows the same pattern as prometheus.ts for remote Helm chart deployments.
 */

import { spawn } from 'child_process';

import { assert, rootLogger, sleep } from '@hyperlane-xyz/utils';

import { fetchGCPSecret } from '../../utils/gcloud.js';
import {
  HelmCommand,
  addHelmRepoIfRequired,
  getDeployableHelmChartName,
  helmifyValues,
} from '../../utils/helm.js';
import { execCmd } from '../../utils/utils.js';

import {
  HASURA_HELM_CHART,
  type HasuraExplorerConfig,
  type HasuraTrackedTable,
} from './config.js';

const logger = rootLogger.child({ module: 'explorer-api' });

export async function runHasuraExplorerHelmCommand(
  action: HelmCommand,
  config: HasuraExplorerConfig,
) {
  await addHelmRepoIfRequired(HASURA_HELM_CHART);
  const chartName = getDeployableHelmChartName(HASURA_HELM_CHART);

  if (action === HelmCommand.Remove) {
    return execCmd(
      `helm ${action} ${config.releaseName} --namespace ${config.namespace}`,
      {},
      false,
      true,
    );
  }

  const values = await getHasuraHelmValues(config);
  const setArgs = helmifyValues(values);

  return execCmd(
    `helm ${action} ${config.releaseName} ${chartName} --create-namespace --namespace ${config.namespace} --version ${HASURA_HELM_CHART.version} ${setArgs.join(' ')}`,
    {},
    false,
    true,
  );
}

async function getHasuraHelmValues(config: HasuraExplorerConfig) {
  const dbUrl = await fetchDbConnectionString(config.dbConnectionSecretName);
  const adminSecret = await fetchAdminSecret(config.adminSecretName);

  return {
    image: {
      tag: config.imageTag,
    },
    replicas: config.replicas,
    resources: config.resources,
    // Disable built-in postgres — use external Cloud SQL
    postgres: {
      enabled: false,
    },
    config: {
      unauthorizedRole: 'anonymous',
      enableConsole: config.enableConsole,
      devMode: false,
      extraConfigs: {
        HASURA_GRAPHQL_ENABLE_INTROSPECTION: 'false',
        HASURA_GRAPHQL_ENABLED_APIS: 'graphql,metadata',
        HASURA_GRAPHQL_ENABLE_QUERY_CACHING: 'true',
        HASURA_GRAPHQL_QUERY_CACHE_TTL: String(config.cacheTtl),
        HASURA_GRAPHQL_PG_CONNECTIONS: '50',
        HASURA_GRAPHQL_PG_TIMEOUT: '180',
        HASURA_GRAPHQL_ENABLE_TELEMETRY: 'false',
        HASURA_GRAPHQL_LOG_LEVEL: 'info',
      },
    },
    secret: {
      adminSecret,
      metadataDbUrl: dbUrl,
    },
    // Chart's metadataDbUrl maps to METADATA_DATABASE_URL (metadata only);
    // DATABASE_URL adds the DB as the default data source
    extraEnvs: [{ name: 'HASURA_GRAPHQL_DATABASE_URL', value: dbUrl }],
    service: {
      type: 'ClusterIP',
    },
  };
}

/**
 * Applies Hasura metadata to track tables with anonymous read-only access.
 * Intended to be run after deploying Hasura, via kubectl port-forward.
 *
 * @param hasuraUrl - Hasura URL (e.g. http://localhost:8080 via port-forward)
 * @param adminSecret - Hasura admin secret
 * @param tables - Tables to track with anonymous select permissions
 */
export async function applyHasuraMetadata(
  hasuraUrl: string,
  adminSecret: string,
  tables: HasuraTrackedTable[],
) {
  logger.info(`Applying metadata to ${hasuraUrl} for ${tables.length} tables`);

  for (const table of tables) {
    // Track the table
    logger.info(`Tracking table: ${table.schema}.${table.name}`);
    await hasuraMetadataRequest(hasuraUrl, adminSecret, {
      type: 'pg_track_table',
      args: {
        source: 'default',
        table: { schema: table.schema, name: table.name },
      },
    });

    // Create anonymous select permission
    logger.info(`Setting anonymous select permission on: ${table.name}`);
    await hasuraMetadataRequest(hasuraUrl, adminSecret, {
      type: 'pg_create_select_permission',
      args: {
        source: 'default',
        table: { schema: table.schema, name: table.name },
        role: 'anonymous',
        permission: {
          columns: '*',
          filter: {},
          allow_aggregations: true,
        },
      },
    });
  }

  logger.info('Metadata applied successfully');
}

async function hasuraMetadataRequest(
  hasuraUrl: string,
  adminSecret: string,
  body: Record<string, unknown>,
) {
  const response = await fetch(`${hasuraUrl}/v1/metadata`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hasura-Admin-Secret': adminSecret,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    // "already tracked" / "permission already exists" are idempotent — not errors
    if (text.includes('already tracked') || text.includes('already exists')) {
      logger.debug(`Idempotent: ${text}`);
      return;
    }
    throw new Error(`Hasura metadata API error (${response.status}): ${text}`);
  }
}

/**
 * Waits for Hasura to be healthy, then applies metadata.
 * Uses kubectl port-forward (same pattern as prometheus.ts).
 */
export async function applyHasuraMetadataViaPortForward(
  config: HasuraExplorerConfig,
) {
  const adminSecret = await fetchAdminSecret(config.adminSecretName);
  const localPort = 18080;
  const svcName = `${config.releaseName}-graphql-engine`;

  const child = await startPortForward(
    svcName,
    config.namespace,
    localPort,
    8080,
  );

  try {
    const hasuraUrl = `http://localhost:${localPort}`;

    // Wait for Hasura to be ready
    for (let i = 0; i < 30; i++) {
      try {
        const resp = await fetch(`${hasuraUrl}/healthz`);
        if (resp.ok) break;
      } catch {
        // not ready yet
      }
      logger.info('Waiting for Hasura to be ready...');
      await sleep(2000);
      assert(i < 29, 'Hasura did not become healthy within 60s');
    }

    const tables = config.trackedTables.map((t) =>
      typeof t === 'string' ? { schema: 'public', name: t } : t,
    );
    await applyHasuraMetadata(hasuraUrl, adminSecret, tables);
  } finally {
    child.kill();
  }
}

function startPortForward(
  svcName: string,
  namespace: string,
  localPort: number,
  remotePort: number,
): Promise<import('child_process').ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn('kubectl', [
      'port-forward',
      `svc/${svcName}`,
      `${localPort}:${remotePort}`,
      '-n',
      namespace,
    ]);

    child.stdout.on('data', (data: Buffer) => {
      const output = data.toString();
      logger.info(`port-forward: ${output.trim()}`);
      if (output.includes('Forwarding from')) {
        resolve(child);
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      logger.error(`port-forward stderr: ${data.toString().trim()}`);
    });

    child.on('error', reject);
    child.on('close', (code) => {
      reject(new Error(`port-forward exited unexpectedly with code ${code}`));
    });
  });
}

async function fetchDbConnectionString(secretName: string): Promise<string> {
  logger.info(`Fetching DB connection string from secret: ${secretName}`);
  const secret = await fetchGCPSecret(secretName, false);
  return (secret as string).trim();
}

async function fetchAdminSecret(secretName: string): Promise<string> {
  logger.info(`Fetching admin secret from secret: ${secretName}`);
  try {
    const secret = await fetchGCPSecret(secretName, false);
    return (secret as string).trim();
  } catch {
    logger.warn(
      `Admin secret ${secretName} not found in GCP Secret Manager, generating a random one. Create this secret for stable admin access.`,
    );
    return crypto.randomUUID();
  }
}
