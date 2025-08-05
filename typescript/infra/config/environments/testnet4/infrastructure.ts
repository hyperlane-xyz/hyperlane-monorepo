import { InfrastructureConfig } from '../../../src/config/infrastructure.js';

export const infrastructure: InfrastructureConfig = {
  kubernetes: {
    clusterName: 'hyperlane-testnet',
  },
  monitoring: {
    namespace: 'monitoring',
    prometheus: {
      deployName: 'prometheus',
      // Node exporter does not work with GKE Autopilot
      nodeExporterEnabled: true,
      helmChart: {
        // See https://github.com/prometheus-community/helm-charts#usage
        repository: {
          name: 'prometheus-community',
          url: 'https://prometheus-community.github.io/helm-charts',
        },
        name: 'prometheus',
        version: '25.21.0',
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
      version: '0.5.1',
    },
    gcpServiceAccountName: 'k8s-external-secrets-testnet4',
    accessibleGCPSecretPrefixes: [
      'hyperlane-testnet-',
      'testnet-',
      'hyperlane-testnet3-',
      'rc-testnet3-',
      'testnet3-',
      'hyperlane-testnet4-',
      'rc-testnet4-',
      'testnet4-',
      // All vanguard secrets
      'vanguard',
    ],
  },
};
