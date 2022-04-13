import { InfrastructureConfig } from '../../../src/config';

export const infra: InfrastructureConfig = {
  kubernetes: { clusterName: '' },
  externalSecrets: {
    namespace: '',
    gcpServiceAccountName: '',
    helmChart: { name: '', version: '' },
    accessibleGCPSecretPrefixes: [],
  },
  monitoring: {
    namespace: '',
    prometheus: {
      deployName: '',
      nodeExporterEnabled: true,
      helmChart: { name: '', version: '' },
    },
  },
};
