import { ContractMetricsConfig } from '../../../src/config/contract-metrics';

export const contractMetrics: ContractMetricsConfig = {
  namespace: 'optics-dev',
  environment: 'dev',
  docker: {
    repo: 'gcr.io/clabs-optics/optics-monitor',
    tag: 'f0a935c3a199143cb397748f57a32072f8d77d06',
  },
};
