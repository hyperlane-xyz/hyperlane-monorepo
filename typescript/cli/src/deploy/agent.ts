import terminalLink from 'terminal-link';

import { toBase64 } from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import { logBlue, logGreen } from '../logger.js';
import {
  runMultiChainSelectionStep,
  runSingleChainSelectionStep,
} from '../utils/chains.js';
import { readJson, runFileSelectionStep } from '../utils/files.js';

export async function runKurtosisAgentDeploy({
  context,
  originChain,
  relayChains,
  agentConfigurationPath,
}: {
  context: CommandContext;
  originChain?: string;
  relayChains?: string;
  agentConfigurationPath?: string;
}) {
  // Future works: decide what to do with this, since its handled in MultiChainResolver - AGENT_KURTOSIS mode
  if (!originChain) {
    originChain = await runSingleChainSelectionStep(
      context.chainMetadata,
      'Select the origin chain:',
    );
  }
  if (!relayChains) {
    const selectedRelayChains = await runMultiChainSelectionStep({
      chainMetadata: context.chainMetadata,
      message: 'Select chains to relay between',
      requireNumber: 2,
    });
    relayChains = selectedRelayChains.join(',');
  }

  if (!agentConfigurationPath) {
    logBlue(
      '\n',
      'No agent config json was provided. Please specify the agent config json filepath.',
    );
    agentConfigurationPath = await runFileSelectionStep(
      './configs',
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
    'Kurtosis Cloud Link 🔗 (cmd+click or ctrl+click here)',
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
