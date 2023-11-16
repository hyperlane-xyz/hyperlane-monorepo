import { logBlue, logGreen } from '../../logger.js';
import { readChainConfigIfExists } from '../config/chain.js';
import { runSingleChainSelectionStep } from '../utils/chains.js';
import { readJson, runFileSelectionStep } from '../utils/files.js';

export async function runKurtosisAgentDeploy({
  agentConfigurationPath,
  chainConfigPath,
}: {
  agentConfigurationPath: string;
  chainConfigPath: string;
}) {
  if (!chainConfigPath) {
    chainConfigPath = await runFileSelectionStep(
      './configs',
      'origin chain config',
      'chains',
    );
  }
  const customChains = readChainConfigIfExists(chainConfigPath);
  const originChainName = await runSingleChainSelectionStep(
    customChains,
    'Select origin chain',
  );

  // prompt for relay chains
  const relayChainsString = '';

  if (!agentConfigurationPath) {
    logBlue(
      '\n',
      'No agent config json was provided. Please specify the agent config json filepath.',
    );
    agentConfigurationPath = await runFileSelectionStep(
      './artifacts',
      'agent config json',
      'agent_config',
    );
  }
  const agentConfigObject = readJson<any>(agentConfigurationPath);

  const hyperlanePackageConfig = {
    origin_chain_name: originChainName,
    relay_chains: relayChainsString,
    agent_config_json: agentConfigObject,
  };
  console.log(hyperlanePackageConfig);

  const base64HyperlaneConfig = jsonToBase64(hyperlanePackageConfig);
  const kurtosisCloudUrl = getKurtosisCloudUrl(base64HyperlaneConfig);

  logGreen(
    '\n',
    'Click this link to deploy your validator and relayer with Kurtosis:',
    '\n',
    `${kurtosisCloudUrl}`,
  );
  return;
}

const getKurtosisCloudUrl = (base64Params: string) =>
  `https://cloud.kurtosis.com/enclave-manager/package-id=github.com%2Fkurtosis-tech%2Fhyperlane-package&package-args=${base64Params}`;

function jsonToBase64(jsonData: any): string {
  try {
    const jsonString = JSON.stringify(jsonData);
    console.log(jsonString);
    const base64String = btoa(jsonString);
    return base64String;
  } catch (error) {
    console.error('Error converting JSON to base64:', error);
    return '';
  }
}
