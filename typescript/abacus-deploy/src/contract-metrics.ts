import { ChainConfig } from '@abacus-network/abacus-deploy';
import { ContractMetricsConfig } from './config/contract-metrics';
import { HelmCommand, helmifyValues } from './utils/helm';
import { execCmd } from './utils/utils';

export async function runContractMetricsHelmCommand(
  action: HelmCommand,
  contractMetricsConfig: ContractMetricsConfig,
  chainConfigs: ChainConfig[],
  environment: string,
) {
  const values = await getContractMetricsHelmChartValues(
    contractMetricsConfig,
    chainConfigs,
    environment,
  );

  return execCmd(
    `helm ${action} contract-metrics ../contract-metrics/helm/optics-monitor --namespace ${
      contractMetricsConfig.namespace
    } ${values.join(' ')}`,
    {},
    false,
    true,
  );
}

async function getContractMetricsHelmChartValues(
  contractMetricsConfig: ContractMetricsConfig,
  chainConfigs: ChainConfig[],
  environment: string,
) {
  const config = {
    image: {
      repository: contractMetricsConfig.docker.repo,
      tag: contractMetricsConfig.docker.tag,
    },
    monitor: {
      environment,
      networks: chainConfigs.map((chainConfig) => chainConfig.name),
    },
    fullnameOverride: 'contract-metrics',
  };
  return helmifyValues(config);
}
