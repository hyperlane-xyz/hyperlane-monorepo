import { logBlue, logGreen, logRed } from '../../logger.js';
import { readJson, runFileSelectionStep } from '../utils/files.js';

export async function runKurtosisAgentDeploy({
  originChain,
  agentConfigurationPath,
  relayChains,
}: {
  originChain: string;
  agentConfigurationPath: string;
  relayChains: string;
}) {
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

  const hyperlanePackageArgs = {
    origin_chain_name: originChain,
    relay_chains: relayChains,
    agent_config_json: JSON.stringify(agentConfigObject),
  };

  const kurtosisPackageConfig = {
    restartServices: true,
    args: hyperlanePackageArgs,
  };

  const base64EncodedPackageConfig = jsonToBase64(kurtosisPackageConfig);
  const kurtosisCloudUrl = getKurtosisCloudUrl(base64EncodedPackageConfig);

  logGreen(
    '\n',
    'Click this link to deploy your validator and relayer with Kurtosis:',
    '\n',
    `${kurtosisCloudUrl}`,
  );
  return;
}

const getKurtosisCloudUrl = (base64Params: string) =>
  `https://cloud.kurtosis.com/enclave-manager?package-id=github.com%2Fkurtosis-tech%2Fhyperlane-package&package-args=${base64Params}`;

function jsonToBase64(jsonData: any): string {
  try {
    return btoa(JSON.stringify(jsonData));
  } catch (error) {
    logRed('Error occurred creating kurtosis cloud url.');
    return '';
  }
}
