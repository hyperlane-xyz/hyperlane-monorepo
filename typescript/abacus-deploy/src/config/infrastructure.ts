interface KubernetesConfig {
  clusterName: string;
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
  nodeExporterEnabled: boolean;
  helmChart: HelmChartConfig;
}

interface MonitoringConfig {
  // Namespace where all monitoring resources live
  namespace: string;
  prometheus: PrometheusConfig;
}

export interface InfrastructureConfig {
  kubernetes: KubernetesConfig;
  monitoring: MonitoringConfig;
}
