import { ContractMetricsConfig } from '../../../src/config/contract-metrics';

export const contractMetrics: ContractMetricsConfig = {
  namespace: 'optics-production-community',
  environment: 'mainnet',
  docker: {
    repo: 'gcr.io/clabs-optics/optics-monitor',
    tag: '8d5cb4b343aca704f36f50b09163c77a095f60ad',
  },
};
