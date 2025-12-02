import { ethers } from 'ethers';
import { fromError } from 'zod-validation-error';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  AgentConfig,
  AgentConfigSchema,
  ChainMap,
  HyperlaneCore,
  HyperlaneDeploymentArtifacts,
  buildAgentConfig,
} from '@hyperlane-xyz/sdk';
import { objMap, pick, promiseObjAll } from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import { errorRed, logBlue, logGreen, warnYellow } from '../logger.js';
import { writeYamlOrJson } from '../utils/files.js';

import { autoConfirm } from './prompts.js';

export async function createAgentConfig({
  context,
  chains,
  out,
}: {
  context: CommandContext;
  chains?: string[];
  out: string;
}) {
  logBlue('\nCreating agent config...');

  const { registry, multiProvider, chainMetadata, skipConfirmation } = context;
  const addresses = await registry.getAddresses();

  await handleNoChainsProvided(skipConfirmation, chains);

  const chainAddresses = filterChainAddresses(addresses, chains);

  const core = HyperlaneCore.fromAddressesMap(chainAddresses, multiProvider);
  const startBlocks = await getStartBlocks(chainAddresses, core, chainMetadata);

  await handleMissingInterchainGasPaymaster(chainAddresses, skipConfirmation);

  const agentConfig = buildAgentConfig(
    Object.keys(chainAddresses),
    multiProvider,
    chainAddresses as ChainMap<HyperlaneDeploymentArtifacts>,
    startBlocks,
  );

  await validateAgentConfig(agentConfig, skipConfirmation);

  logBlue(`\nWriting agent config to file ${out}`);
  writeYamlOrJson(out, agentConfig, 'json');
  logGreen(`✅ Agent config successfully written to ${out}`);
}

async function handleNoChainsProvided(
  skipConfirmation: boolean,
  chains?: string[],
) {
  if (!chains || chains.length === 0) {
    const proceedWithAllChains = await autoConfirm(
      '\nNo chains provided, would you like to generate the agent config for all supported chains?',
      skipConfirmation,
      () => logBlue('Generating agent config for all supported chains'),
    );
    if (!proceedWithAllChains) {
      errorRed('❌ Agent config creation aborted');
      process.exit(1);
    }
  }
}

function filterChainAddresses(
  addresses: ChainMap<ChainAddresses>,
  chains?: string[],
) {
  if (!chains) {
    return addresses;
  }

  return pick(addresses, chains);
}

async function getStartBlocks(
  chainAddresses: ChainMap<ChainAddresses>,
  core: HyperlaneCore,
  chainMetadata: any,
): Promise<ChainMap<number | undefined>> {
  return promiseObjAll(
    objMap(chainAddresses, async (chain, _) => {
      const indexFrom = chainMetadata[chain].index?.from;
      if (indexFrom !== undefined) {
        return indexFrom;
      }

      const mailbox = core.getContracts(chain).mailbox;
      try {
        const deployedBlock = await mailbox.deployedBlock();
        return deployedBlock.toNumber();
      } catch {
        errorRed(
          `❌ Failed to get deployed block to set an index for ${chain}, this is potentially an issue with rpc provider or a misconfiguration`,
        );
        return undefined;
      }
    }),
  );
}

async function handleMissingInterchainGasPaymaster(
  chainAddresses: ChainMap<ChainAddresses>,
  skipConfirmation: boolean,
) {
  for (const [chain, addressesRecord] of Object.entries(chainAddresses)) {
    if (!addressesRecord.interchainGasPaymaster) {
      warnYellow(`interchainGasPaymaster address is missing for ${chain}`);
      const useZeroIgpAddress = await autoConfirm(
        `\nWould you like to set the interchainGasPaymaster address to 0x0 for ${chain}?`,
        skipConfirmation,
        () =>
          logBlue(`Setting interchainGasPaymaster address to 0x0 for ${chain}`),
      );

      if (useZeroIgpAddress) {
        chainAddresses[chain].interchainGasPaymaster =
          ethers.constants.AddressZero;
      }
    }
  }
}

async function validateAgentConfig(
  agentConfig: AgentConfig,
  skipConfirmation: boolean,
) {
  const result = AgentConfigSchema.safeParse(agentConfig);
  if (!result.success) {
    const errorMessage = fromError(result.error).toString();
    warnYellow(
      `\nAgent config is invalid, this is possibly due to required contracts not being deployed. See details below:\n${errorMessage}`,
    );
    const continueAnyway = await autoConfirm(
      'Would you like to continue anyway?',
      skipConfirmation,
      () => logBlue('Creating agent config anyway...'),
    );

    if (!continueAnyway) {
      errorRed('\n❌ Agent config creation aborted');
      process.exit(1);
    }
  } else {
    logGreen('✅ Agent config successfully created');
  }
}
