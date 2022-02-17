import { InfrastructureConfig } from "../../../src/config/infrastructure";

export const infrastructure: InfrastructureConfig = {
  kubernetes: {
    clusterName: 'optics-dev',
  },
  monitoring: {
    namespace: 'monitoring',
    prometheus: {
      deployName: 'prometheus',
      // Node exporter does not work with GKE Autopilot
      nodeExporterEnabled: false,
      helmChart: {
        // See https://github.com/prometheus-community/helm-charts#usage
        repository: {
          name: 'prometheus-community',
          url: 'https://prometheus-community.github.io/helm-charts',
        },
        name: 'prometheus',
        version: '14.1.2',
      },
    },
  },
};
