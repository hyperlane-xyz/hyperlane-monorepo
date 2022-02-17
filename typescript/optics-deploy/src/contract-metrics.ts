import { ChainConfig } from './config/chain';
import { HelmCommand, helmifyValues } from './utils/helm';
import { execCmd } from './utils/utils';

export async function runContractMetricsHelmCommand(
    action: HelmCommand,
    chainConfigs: ChainConfig[],
    namespace: string,
    environment: string
) {
  const values = await getPrometheusHelmChartValues(chainConfigs, environment);

  return execCmd(
    `helm ${action} contract-metrics ../../contract-metrics/helm/optics-monitor --namespace ${namespace} ${values.join(' ')}`,
    {},
    false,
    true,
  );
}

async function getPrometheusHelmChartValues(chainConfigs: ChainConfig[], environment: string) {
  let envFileContents = `ENVIRONMENT=${environment}`;
  for (const chainConfig of chainConfigs) {
    envFileContents += `\n${chainConfig.name.toUpperCase()}_RPC='${chainConfig.json.rpc}'`;
  }

  const config = {
    monitor: {
      config: envFileContents,
    },
  };
  return helmifyValues(config);
}