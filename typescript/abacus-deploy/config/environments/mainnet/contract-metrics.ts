
import { ContractMetricsConfig } from "../../../src/config/contract-metrics";

export const contractMetrics: ContractMetricsConfig = {
  namespace: 'optics-production-community',
  environment: 'mainnet',
  docker: {
    repo: 'gcr.io/clabs-optics/optics-monitor',
    tag: 'e305f79de779c4b7412edb4082ffec9c076c04a7',
  },
}
