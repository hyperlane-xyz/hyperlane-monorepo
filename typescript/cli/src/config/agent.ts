import { ethers } from 'ethers';
import { fromError } from 'zod-validation-error';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  AgentConfig,
  AgentConfigSchema,
  ChainMap,
  ChainMetadata,
  HyperlaneCore,
  HyperlaneDeploymentArtifacts,
  buildAgentConfig,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  assert,
  objMap,
  pick,
  promiseObjAll,
} from '@hyperlane-xyz/utils';

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

  // Categorize chains by protocol
  const chainsByProtocol: Record<string, string[]> = {
    ethereum: [],
    starknet: [],
  };

  Object.keys(chainMetadata).forEach((chain) => {
    const protocol = chainMetadata[chain].protocol;
    if (protocol === ProtocolType.Starknet) {
      chainsByProtocol.starknet.push(chain);
    } else {
      chainsByProtocol.ethereum.push(chain);
    }
  });

  // Initialize core for Ethereum chains
  const ethereumChainAddresses = pick(
    chainAddresses,
    chainsByProtocol.ethereum,
  );
  const core = HyperlaneCore.fromAddressesMap(
    ethereumChainAddresses,
    multiProvider,
  );
  const ethereumStartBlocks = await getStartBlocks(
    ethereumChainAddresses,
    core,
    chainMetadata,
  );

  const starknetStartBlocks = await getStartBlocksForStarknetChains(
    chainsByProtocol.starknet,
    pick(chainAddresses, chainsByProtocol.starknet),
    chainMetadata,
  );

  const startBlocks: ChainMap<number | undefined> = {
    ...ethereumStartBlocks,
    ...starknetStartBlocks,
  };

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
  chainMetadata: ChainMap<ChainMetadata>,
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

async function getStartBlocksForStarknetChains(
  starknetChains: string[],
  starknetChainAddresses: ChainMap<ChainAddresses>,
  chainMetadata: ChainMap<ChainMetadata>,
): Promise<ChainMap<number | undefined>> {
  const startBlocks: ChainMap<number | undefined> = {};

  for (const chain of starknetChains) {
    try {
      // Assert chain data and explorer existence
      const chainData = chainMetadata[chain];
      assert(chainData, `No chain metadata found for ${chain}`);
      assert(chainData.blockExplorers?.[0], `No explorer found for ${chain}`);

      // Assert mailbox address existence
      const mailboxAddress = starknetChainAddresses[chain]?.mailbox;
      assert(mailboxAddress, `No mailbox address found for ${chain}`);

      const explorer = chainData.blockExplorers[0];
      const response = await fetch(
        `${explorer.apiUrl}/contract/${mailboxAddress}`,
      );

      // Assert response status
      assert(
        response.ok,
        `API request failed for ${chain}: ${response.statusText}`,
      );

      const data = await response.json();
      // Assert block number existence and type
      assert(
        typeof data.blockNumber === 'number',
        `Invalid block number format for ${chain}`,
      );

      startBlocks[chain] = data.blockNumber;
    } catch (error) {
      console.error(`Failed to fetch start block for ${chain}:`, error);
      startBlocks[chain] = undefined;
    }
  }

  return startBlocks;
}
