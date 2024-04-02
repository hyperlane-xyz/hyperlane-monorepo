import terminalLink from 'terminal-link';

import { toBase64 } from '@hyperlane-xyz/utils';

import { getContext } from '../context.js';
import { logBlue, logGreen } from '../logger.js';
import {
  runMultiChainSelectionStep,
  runSingleChainSelectionStep,
} from '../utils/chains.js';
import { readJson, runFileSelectionStep } from '../utils/files.js';

export async function runKurtosisAgentDeploy({
  originChain,
  relayChains,
  chainConfigPath,
  agentConfigurationPath,
}: {
  originChain: string;
  relayChains: string;
  chainConfigPath: string;
  agentConfigurationPath: string;
}) {
  const { customChains } = await getContext({ chainConfigPath });

  if (!originChain) {
    originChain = await runSingleChainSelectionStep(
      customChains,
      'Select the origin chain',
    );
  }
  if (!relayChains) {
    const selectedRelayChains = await runMultiChainSelectionStep(
      customChains,
      'Select chains to relay between',
      true,
    );
    relayChains = selectedRelayChains.join(',');
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

  const base64EncodedPackageConfig = toBase64(kurtosisPackageConfig) || '';
  const kurtosisCloudUrl = getKurtosisCloudUrl(base64EncodedPackageConfig);

  const kurtosisCloudLink = terminalLink(
    'Cmd+Click or Ctrl+Click here',
    kurtosisCloudUrl,
    { fallback: () => kurtosisCloudUrl },
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
