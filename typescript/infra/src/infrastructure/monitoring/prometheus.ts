import { InfrastructureConfig } from '../../config/infrastructure.js';
import { fetchGCPSecret } from '../../utils/gcloud.js';
import {
  HelmCommand,
  addHelmRepoIfRequired,
  getDeployableHelmChartName,
  helmifyValues,
} from '../../utils/helm.js';
import { execCmd } from '../../utils/utils.js';

interface PrometheusSecrets {
  remote_write_uri: string;
  remote_write_username: string;
  remote_write_password: string;
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
                '(container.*|optics.*|Optics.*|prometheus.*|ethereum.*|hyperlane.*|kube_pod_status_phase|kube_pod_container_status_restarts_total)',
              source_labels: ['__name__'],
            },
          ],
        },
      ],
    },
    nodeExporter: {
      enabled: infraConfig.monitoring.prometheus.nodeExporterEnabled,
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
