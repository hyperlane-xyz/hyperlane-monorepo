import { confirm } from '@inquirer/prompts';
import { fromError } from 'zod-validation-error';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  AgentConfigSchema,
  ChainMap,
  HyperlaneCore,
  HyperlaneDeploymentArtifacts,
  buildAgentConfig,
} from '@hyperlane-xyz/sdk';
import { objFilter, objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import { errorRed, logBlue, logGreen, warnYellow } from '../logger.js';
import { writeYamlOrJson } from '../utils/files.js';

export async function createAgentConfig({
  context,
  chains,
  out,
  skipPrompts = false,
}: {
  context: CommandContext;
  chains?: string[];
  out: string;
  skipPrompts?: boolean;
}) {
  logBlue('\nCreating agent config...');

  const { registry, multiProvider, chainMetadata } = context;
  const addresses = await registry.getAddresses();

  if (!chains) {
    if (skipPrompts) {
      logBlue(
        '\nNo chains provided, generating agent config for all supported chains',
      );
    } else {
      const proceedWithAllChains = await confirm({
        message:
          '\nNo chains provided, would you like to generate the agent config for all supported chains?',
      });
      if (!proceedWithAllChains) {
        errorRed('❌ Agent config creation aborted');
        process.exit(1);
      }
    }
  }

  let chainAddresses = addresses;
  if (chains) {
    // Filter out only the chains that are provided
    chainAddresses = objFilter(addresses, (chain, _): _ is ChainAddresses => {
      return chains.includes(chain);
    });
  }

  const core = HyperlaneCore.fromAddressesMap(chainAddresses, multiProvider);
  const startBlocks = await promiseObjAll(
    objMap(chainAddresses, async (chain, _) => {
      // If the index.from is specified in the chain metadata, use that.
      const indexFrom = chainMetadata[chain].index?.from;
      if (indexFrom !== undefined) {
        return indexFrom;
      }

      const mailbox = core.getContracts(chain).mailbox;
      try {
        const deployedBlock = await mailbox.deployedBlock();
        return deployedBlock.toNumber();
      } catch (err) {
        errorRed(
          `❌ Failed to get deployed block to set an index for ${chain}, this is potentially an issue with rpc provider or a misconfiguration`,
        );
        process.exit(1);
      }
    }),
  );

  if (!skipPrompts) {
    // set interchainGasPaymaster to 0x0 if it is missing
    for (const [chain, addressesRecord] of Object.entries(chainAddresses)) {
      if (!addressesRecord.interchainGasPaymaster) {
        warnYellow(`interchainGasPaymaster address is missing for ${chain}`);
        const zeroIGPAddress = await confirm({
          message: `Would you like to set the interchainGasPaymaster address to 0x0 for ${chain}?`,
        });

        if (zeroIGPAddress) {
          chainAddresses[chain].interchainGasPaymaster =
            '0x0000000000000000000000000000000000000000';
        }
      }
    }
  }

  // @TODO: consider adding additional config used to pass in gas prices for Cosmos chains
  const agentConfig = buildAgentConfig(
    chains ?? Object.keys(chainAddresses),
    multiProvider,
    chainAddresses as ChainMap<HyperlaneDeploymentArtifacts>,
    startBlocks,
  );

  const result = AgentConfigSchema.safeParse(agentConfig);
  if (!result.success) {
    const errorMessage = fromError(result.error).toString();
    warnYellow(
      `\nAgent config is invalid, this is possibly due to required contracts not being deployed. See details below:\n${errorMessage}`,
    );

    if (skipPrompts) {
      logBlue('Creating agent config anyway...');
    } else {
      const continueAnyway = await confirm({
        message: 'Would you like to continue anyway?',
      });

      if (!continueAnyway) {
        errorRed('\n❌ Agent config creation aborted');
        process.exit(1);
      }
    }
  } else {
    logGreen('✅ Agent config successfully created');
  }

  logBlue(`\nWriting agent config to file ${out}`);
  writeYamlOrJson(out, agentConfig, 'json');
  logGreen(`✅ Agent config successfully written to ${out}`);
}
