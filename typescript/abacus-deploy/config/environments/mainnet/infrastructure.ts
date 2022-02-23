import { InfrastructureConfig } from '../../../src/config/infrastructure';

export const infrastructure: InfrastructureConfig = {
  kubernetes: {
    clusterName: 'optics-west1',
  },
  monitoring: {
    namespace: 'monitoring',
    prometheus: {
      deployName: 'prometheus',
      nodeExporterEnabled: true,
      helmChart: {
        // See https://github.com/prometheus-community/helm-charts#usage
        repository: {
          name: 'prometheus-community',
          url: 'https://prometheus-community.github.io/helm-charts',
        },
        name: 'prometheus',
        version: '15.0.1',
      },
    },
  },
  externalSecrets: {
    namespace: 'external-secrets',
    helmChart: {
      repository: {
        name: 'external-secrets',
        url: 'https://charts.external-secrets.io',
      },
      name: 'external-secrets',
      version: '0.4.4',
    },
    gcpServiceAccountName: 'k8s-external-secrets-mainnet',
  },
};
