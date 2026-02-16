/**
 * Cloud SQL Postgres infrastructure for the Explorer API
 *
 * This module creates a Cloud SQL Postgres instance using Pulumi.
 * The instance is configured to support the scraper write load and Hasura read queries.
 */

import * as gcp from '@pulumi/gcp';
import * as pulumi from '@pulumi/pulumi';

import type { CloudSqlConfig } from './config.js';

export interface CloudSqlOutputs {
  /** The Cloud SQL instance */
  instance: gcp.sql.DatabaseInstance;
  /** The database */
  database: gcp.sql.Database;
  /** The database user */
  user: gcp.sql.User;
  /** Connection name for the instance */
  connectionName: pulumi.Output<string>;
  /** Private IP address (if enabled) */
  privateIpAddress: pulumi.Output<string>;
  /** Public IP address (if enabled) */
  publicIpAddress: pulumi.Output<string | undefined>;
}

/**
 * Creates a Cloud SQL Postgres instance for the Explorer API
 *
 * @param config - Cloud SQL configuration
 * @param dbPassword - Database password (should be passed as a Pulumi secret)
 * @returns Cloud SQL outputs including instance, database, and user
 */
export function createCloudSqlInstance(
  config: CloudSqlConfig,
  dbPassword: pulumi.Input<string>,
): CloudSqlOutputs {
  // Create the Cloud SQL instance
  const instance = new gcp.sql.DatabaseInstance(
    config.instanceName,
    {
      name: config.instanceName,
      project: config.projectId,
      region: config.region,
      databaseVersion: 'POSTGRES_15',
      deletionProtection: true,
      settings: {
        tier: config.tier,
        diskSize: config.diskSizeGb,
        diskType: 'PD_SSD',
        diskAutoresize: true,
        diskAutoresizeLimit: config.diskSizeGb * 4, // Allow 4x growth

        // Availability configuration
        availabilityType: config.highAvailability ? 'REGIONAL' : 'ZONAL',

        // IP configuration
        ipConfiguration: {
          ipv4Enabled: !config.privateIpEnabled,
          privateNetwork: config.privateIpEnabled
            ? config.vpcNetwork
            : undefined,
          // Note: SSL is enforced at the connection level via the connection string (sslmode=require)
          authorizedNetworks: config.authorizedNetworks.map((net) => ({
            name: net.name,
            value: net.value,
          })),
        },

        // Maintenance window
        maintenanceWindow: config.maintenanceWindow
          ? {
              day: config.maintenanceWindow.day,
              hour: config.maintenanceWindow.hour,
              updateTrack: 'stable',
            }
          : undefined,

        // Backup configuration
        backupConfiguration: config.backupConfiguration
          ? {
              enabled: config.backupConfiguration.enabled,
              startTime: config.backupConfiguration.startTime,
              backupRetentionSettings: {
                retainedBackups:
                  config.backupConfiguration.retainedBackups ?? 7,
                retentionUnit: 'COUNT',
              },
              pointInTimeRecoveryEnabled:
                config.backupConfiguration.pointInTimeRecoveryEnabled ?? false,
              transactionLogRetentionDays: config.backupConfiguration
                .pointInTimeRecoveryEnabled
                ? 7
                : undefined,
            }
          : undefined,

        // Database flags optimized for write-heavy workload
        databaseFlags: [
          // Connection settings
          { name: 'max_connections', value: '200' },

          // Write performance tuning
          { name: 'checkpoint_completion_target', value: '0.9' },
          { name: 'wal_buffers', value: '64MB' },

          // Query performance
          { name: 'work_mem', value: '64MB' },
          { name: 'maintenance_work_mem', value: '512MB' },
          { name: 'effective_cache_size', value: '12GB' },

          // Logging (for debugging)
          { name: 'log_min_duration_statement', value: '1000' }, // Log queries > 1s
        ],

        // Insights configuration for monitoring
        insightsConfig: {
          queryInsightsEnabled: true,
          queryPlansPerMinute: 5,
          queryStringLength: 1024,
          recordApplicationTags: true,
          recordClientAddress: true,
        },

        // User labels for resource organization
        userLabels: {
          environment: config.instanceName.includes('testnet')
            ? 'testnet'
            : 'mainnet',
          application: 'explorer-api',
          managed_by: 'pulumi',
        },
      },
    },
    {
      protect: true, // Prevent accidental deletion
    },
  );

  // Create the database
  const database = new gcp.sql.Database(
    `${config.instanceName}-db`,
    {
      name: config.databaseName,
      instance: instance.name,
      project: config.projectId,
      charset: 'UTF8',
      collation: 'en_US.UTF8',
    },
    {
      dependsOn: [instance],
    },
  );

  // Create the database user for Hasura/scraper
  const user = new gcp.sql.User(
    `${config.instanceName}-user`,
    {
      name: 'explorer',
      instance: instance.name,
      project: config.projectId,
      password: dbPassword,
    },
    {
      dependsOn: [instance],
    },
  );

  return {
    instance,
    database,
    user,
    connectionName: instance.connectionName,
    privateIpAddress: instance.privateIpAddress,
    publicIpAddress: instance.publicIpAddress,
  };
}

/**
 * Creates a GCP Secret Manager secret for the database connection string
 *
 * @param secretId - Secret ID
 * @param projectId - GCP project ID
 * @param connectionString - Database connection string
 * @returns The created secret
 */
export function createDbConnectionSecret(
  secretId: string,
  projectId: string,
  connectionString: pulumi.Input<string>,
): gcp.secretmanager.Secret {
  const secret = new gcp.secretmanager.Secret(secretId, {
    secretId,
    project: projectId,
    replication: {
      auto: {},
    },
  });

  new gcp.secretmanager.SecretVersion(`${secretId}-version`, {
    secret: secret.id,
    secretData: connectionString,
  });

  return secret;
}

/**
 * Generates PostgreSQL connection string
 *
 * @param user - Database username
 * @param password - Database password
 * @param host - Database host (private IP or Cloud SQL proxy socket)
 * @param port - Database port
 * @param database - Database name
 * @returns PostgreSQL connection string
 */
export function generateConnectionString(
  user: string,
  password: pulumi.Input<string>,
  host: pulumi.Input<string>,
  port: number,
  database: string,
): pulumi.Output<string> {
  return pulumi.interpolate`postgresql://${user}:${password}@${host}:${port}/${database}?sslmode=require`;
}

/**
 * SQL statements to create the scraper views (to be executed after migrations)
 * These views are required by the Explorer API and are created by the scraper migrations,
 * but documented here for reference.
 */
export const REQUIRED_VIEWS = [
  'message_view', // Main message view with all related data
  'total_gas_payment', // Aggregated gas payments per message
];

/**
 * Tables that need to be tracked in Hasura
 */
export const HASURA_TRACKED_TABLES = [
  'domain', // Domain/chain information
  'message_view', // Main message view for queries
  'raw_message_dispatch', // Raw dispatch events for CCTP/Phase 2 consumers
];
