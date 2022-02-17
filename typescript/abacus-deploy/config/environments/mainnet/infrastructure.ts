export const infrastructure = {
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
        version: '14.1.2',
      },
    },
  },
};
