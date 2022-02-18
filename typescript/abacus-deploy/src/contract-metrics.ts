import { ChainConfig } from './config/chain';
import { ContractMetricsConfig } from './config/contract-metrics';
import { HelmCommand, helmifyValues } from './utils/helm';
import { execCmd } from './utils/utils';

export async function runContractMetricsHelmCommand(
  action: HelmCommand,
  contractMetricsConfig: ContractMetricsConfig,
  chainConfigs: ChainConfig[],
) {
  const values = await getPrometheusHelmChartValues(
    contractMetricsConfig,
    chainConfigs,
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

async function getPrometheusHelmChartValues(
  contractMetricsConfig: ContractMetricsConfig,
  chainConfigs: ChainConfig[],
) {
  const envVars = [`ENVIRONMENT=${contractMetricsConfig.environment}`];
  for (const chainConfig of chainConfigs) {
    envVars.push(
      `${chainConfig.name.toUpperCase()}_RPC='${chainConfig.json.rpc}'`,
    );
  }

  const config = {
    image: {
      repository: contractMetricsConfig.docker.repo,
      tag: contractMetricsConfig.docker.tag,
    },
    monitor: {
      config: envVars,
    },
    fullnameOverride: 'contract-metrics',
  };
  return helmifyValues(config);
}
