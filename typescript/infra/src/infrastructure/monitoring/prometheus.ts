import { ChildProcess, spawn } from 'child_process';

import { rootLogger } from '@hyperlane-xyz/utils';

import { InfrastructureConfig } from '../../config/infrastructure.js';
import { fetchGCPSecret } from '../../utils/gcloud.js';
import {
  HelmCommand,
  addHelmRepoIfRequired,
  getDeployableHelmChartName,
  helmifyValues,
} from '../../utils/helm.js';
import { execCmd } from '../../utils/utils.js';

const PROMETHEUS_SERVER_SERVICE_NAME = 'prometheus-server';
const PROMETHEUS_SERVER_NAMESPACE = 'monitoring';
export const PROMETHEUS_LOCAL_PORT = 9090;
export const LOCAL_PROM_URL = `http://localhost:${PROMETHEUS_LOCAL_PORT}`;

interface PrometheusSecrets {
  remote_write_uri: string;
  remote_write_username: string;
  remote_write_password: string;
}

// https://prometheus.io/docs/prometheus/latest/querying/api/#instant-vectors
export interface PrometheusInstantResult {
  metric: Record<string, string>;
  // according to docs either value or histogram will be present, but not both
  value?: [number, string];
  histogram?: [number, Record<string, number>];
}

export async function runPrometheusHelmCommand(
  action: HelmCommand,
  infraConfig: InfrastructureConfig,
  environment: string,
) {
  // Prometheus's helm chart requires a repository to be added
  await addHelmRepoIfRequired(infraConfig.monitoring.prometheus.helmChart);
  // The name passed in must be in the form `repo/chartName`
  const helmChartName = getDeployableHelmChartName(
    infraConfig.monitoring.prometheus.helmChart,
  );

  const values = await getPrometheusHelmChartValues(infraConfig, environment);

  return execCmd(
    `helm ${action} ${
      infraConfig.monitoring.prometheus.deployName
    } ${helmChartName} --namespace ${
      infraConfig.monitoring.namespace
    } --create-namespace --version ${
      infraConfig.monitoring.prometheus.helmChart.version
    } ${values.join(' ')}`,
    {},
    false,
    true,
  );
}

async function getPrometheusHelmChartValues(
  infraConfig: InfrastructureConfig,
  environment: string,
) {
  const config = await getPrometheusConfig(infraConfig, environment);
  return helmifyValues(config);
}

async function getPrometheusConfig(
  infraConfig: InfrastructureConfig,
  environment: string,
) {
  const secrets = await fetchPrometheusSecrets();

  return {
    server: {
      global: {
        external_labels: {
          environment,
          origin_prometheus: infraConfig.kubernetes.clusterName,
        },
      },
      persistentVolume: {
        size: '50Gi',
      },
      remoteWrite: [
        {
          basic_auth: {
            username: secrets.remote_write_username,
            password: secrets.remote_write_password,
          },
          url: secrets.remote_write_uri,
          write_relabel_configs: [
            {
              action: 'keep',
              regex:
                '(container.*|optics.*|Optics.*|prometheus.*|ethereum.*|hyperlane.*|kube_pod_status_phase|kube_pod_container_status_restarts_total|kube_pod_container_resource_requests)',
              source_labels: ['__name__'],
            },
            {
              action: 'labeldrop',
              regex: 'id|controller_revision_hash|name|uid|instance|node',
            },
          ],
        },
      ],
      resources: {
        requests: {
          cpu: '200m',
          memory: '3Gi',
        },
      },
    },
    'prometheus-node-exporter': {
      enabled: infraConfig.monitoring.prometheus.nodeExporterEnabled,
      resources: {
        requests: {
          cpu: '50m',
          memory: '100Mi',
        },
      },
    },
  };
}

// Fetches a secret from GCP Secret Manager. The secret is expected to
// be JSON with the shape of `PrometheusSecrets`.
async function fetchPrometheusSecrets(): Promise<PrometheusSecrets> {
  const secrets = await fetchGCPSecret(
    'hyperlane-prometheus-remote_write_config',
  );
  return secrets as PrometheusSecrets;
}

/**
 * Fetches data from Prometheus using the given URL and query.
 *
 * Returns an array of PrometheusResult objects.
 */
export async function fetchPrometheusInstantExpression(
  promUrl: string,
  promQlQuery: string,
): Promise<PrometheusInstantResult[]> {
  const url = `${promUrl}/api/v1/query?query=${encodeURIComponent(
    promQlQuery,
  )}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Error fetching from Prometheus: ${response.status} - ${response.statusText}`,
    );
  }

  const data = await response.json();

  return data.data?.result ?? [];
}

/**
 * Spawns a `kubectl port-forward ...` process in the background and
 * resolves once we detect the forward is established (via stdout).
 *
 * Returns the `ChildProcess` so you can kill it when done.
 */
export async function portForwardPrometheusServer(
  localPort: number,
  remotePort: number = 80,
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn('kubectl', [
      'port-forward',
      `svc/${PROMETHEUS_SERVER_SERVICE_NAME}`,
      `${localPort}:${remotePort}`,
      '-n',
      PROMETHEUS_SERVER_NAMESPACE,
    ]);

    // Listen to stdout for the line that confirms the forward is active
    child.stdout.on('data', (data) => {
      const output = data.toString();
      rootLogger.info('port-forward stdout:', output);

      if (output.includes('Forwarding from')) {
        // Port-forward is ready, so we can query Prometheus now
        resolve(child);
      }
    });

    // If anything is written to stderr, log it (for debugging).
    child.stderr.on('data', (data) => {
      rootLogger.error('port-forward stderr:', data.toString());
    });

    // If there's an error spawning the process
    child.on('error', (err) => {
      reject(err);
    });

    // If the process closes prematurely, reject
    child.on('close', (code) => {
      reject(
        new Error(`port-forward process exited unexpectedly with code ${code}`),
      );
    });
  });
}
