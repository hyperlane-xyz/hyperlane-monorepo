export interface HelmImageValues {
  repository: string;
  tag: string;
}

// This encompasses things like storage and resources for stateful sets.
export interface HelmStatefulSetValues {
  enabled: boolean;
}

interface KubernetesConfig {
  clusterName: string;
}

export interface HelmChartRepositoryConfig {
  name: string;
  url: string;
}

export interface HelmChartConfig {
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

// Config for external-secrets, which is used to access secrets in GCP secret manager
// via Kubernetes secrets.
// See https://external-secrets.io/v0.4.4/provider-google-secrets-manager
interface ExternalSecretsConfig {
  namespace: string;
  gcpServiceAccountName: string;
  helmChart: HelmChartConfig;
  accessibleGCPSecretPrefixes: string[];
}

export interface InfrastructureConfig {
  kubernetes: KubernetesConfig;
  externalSecrets: ExternalSecretsConfig;
  monitoring: MonitoringConfig;
}
