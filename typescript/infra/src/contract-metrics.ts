import { ChainName } from '@abacus-network/sdk';
import { ContractMetricsConfig } from './config';
import { HelmCommand, helmifyValues } from './utils/helm';
import { execCmd } from './utils/utils';

export async function runContractMetricsHelmCommand(
  action: HelmCommand,
  contractMetricsConfig: ContractMetricsConfig,
  chainNames: ChainName[],
  environment: string,
) {
  const values = await getContractMetricsHelmChartValues(
    contractMetricsConfig,
    chainNames,
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
  chainNames: ChainName[],
  environment: string,
) {
  const config = {
    image: {
      repository: contractMetricsConfig.docker.repo,
      tag: contractMetricsConfig.docker.tag,
    },
    monitor: {
      environment,
      networks: chainNames,
    },
    fullnameOverride: 'contract-metrics',
  };
  return helmifyValues(config);
}
