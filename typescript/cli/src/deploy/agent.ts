import { input } from '@inquirer/prompts';
import terminalLink from 'terminal-link';

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
  if (!originChain) {
    originChain = await input({ message: 'Enter the origin chain' });
  }
  if (!relayChains) {
    relayChains = await input({
      message: 'Enter a comma separated list of chains to relay between',
    });
    relayChains = trimSpaces(relayChains);
  }

  if (!agentConfigurationPath) {
    logBlue(
      '\n',
      'No agent config json was provided. Please specify the agent config json filepath.',
    );
    agentConfigurationPath = await runFileSelectionStep(
      './artifacts',
      'agent config json',
      'agent-config',
    );
  }
  const agentConfigObject = readJson<any>(agentConfigurationPath);

  const hyperlanePackageArgs = {
    plan: '{}',
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

  const kurtosisCloudLink = terminalLink(
    'Cmd+Click or Ctrl+Click here',
    kurtosisCloudUrl,
  );

  logGreen(
    '\n',
    'Click the link below to deploy your validator and relayer with Kurtosis:',
    '\n',
    `${kurtosisCloudLink}`,
  );
  return;
}

const getKurtosisCloudUrl = (base64Params: string) =>
  `https://cloud.kurtosis.com/enclave-manager?package-id=github.com%2Fkurtosis-tech%2Fhyperlane-package&package-args=${base64Params}`;

const trimSpaces = (a: string) =>
  a
    .split('')
    .filter((char) => char !== ' ')
    .join('');

function jsonToBase64(jsonData: any): string {
  try {
    return btoa(JSON.stringify(jsonData));
  } catch (error) {
    logRed('Error occurred creating kurtosis cloud url.');
    return '';
  }
}
