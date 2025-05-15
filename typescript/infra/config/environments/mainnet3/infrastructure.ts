import { InfrastructureConfig } from '../../../src/config/infrastructure.js';

export const infrastructure: InfrastructureConfig = {
  kubernetes: {
    clusterName: 'hyperlane-mainnet',
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
    gcpServiceAccountName: 'k8s-external-secrets-mainnet2',
    accessibleGCPSecretPrefixes: [
      'hyperlane-mainnet-',
      'mainnet-',
      'hyperlane-mainnet2-',
      'rc-mainnet2-',
      'mainnet2-',
      'hyperlane-mainnet3-',
      'rc-mainnet3-',
      'neutron-mainnet3-',
      // All vanguard context secrets. There's a cap on the number of
      // prefixes you can specify in a single IAM policy, so for convenience
      // we just use a single prefix for all vanguard contexts.
      'vanguard',
      'mainnet3-',
    ],
  },
};
