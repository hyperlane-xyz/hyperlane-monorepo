interface KubernetesConfig {
  clusterName: string;
  context: string;
}

export interface HelmChartRepositoryConfig {
  name: string;
  url: string;
}

interface HelmChartConfig {
  name: string;
  version: string;
  // Present if the helm chart requires a repo to be installed
  repository?: HelmChartRepositoryConfig;
}

interface PrometheusConfig {
  deployName: string;
  helmChart: HelmChartConfig;
}

interface MonitoringConfig {
  namespace: string;
  prometheus: PrometheusConfig;
}

export interface InfrastructureConfig {
  kubernetes: KubernetesConfig;
  monitoring: MonitoringConfig;
};