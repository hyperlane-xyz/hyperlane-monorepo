import { ContractMetricsConfig } from '../../../src/config/contract-metrics';

export const contractMetrics: ContractMetricsConfig = {
  namespace: 'optics-production-community',
  environment: 'mainnet',
  docker: {
    repo: 'gcr.io/clabs-optics/optics-monitor',
    tag: '64d5252bb113c25140bb0a0f8e8636a99f2affb1',
  },
};
