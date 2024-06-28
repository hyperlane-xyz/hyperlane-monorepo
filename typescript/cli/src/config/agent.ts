import { fromError } from 'zod-validation-error';

import {
  AgentConfigSchema,
  ChainMap,
  HyperlaneCore,
  HyperlaneDeploymentArtifacts,
  buildAgentConfig,
} from '@hyperlane-xyz/sdk';
import { objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import { errorRed, logBlue, logGreen, logRed } from '../logger.js';
import { writeYamlOrJson } from '../utils/files.js';

export async function createAgentConfig({
  context,
  chains,
  out,
}: {
  context: CommandContext;
  chains: string[];
  out: string;
}) {
  logBlue('\nCreating agent config...');

  const { registry, multiProvider, chainMetadata } = context;
  const addresses = await registry.getAddresses();

  const core = HyperlaneCore.fromAddressesMap(addresses, multiProvider);

  const startBlocks = await promiseObjAll(
    objMap(addresses, async (chain, _) => {
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
        logRed(
          `Failed to get deployed block to set an index for ${chain}, this is potentially an issue with rpc provider or a misconfiguration`,
        );
        process.exit(1);
      }
    }),
  );

  // @TODO: consider adding additional config used to pass in gas prices for Cosmos chains
  const agentConfig = buildAgentConfig(
    chains,
    multiProvider,
    addresses as ChainMap<HyperlaneDeploymentArtifacts>,
    startBlocks,
  );

  try {
    AgentConfigSchema.parse(agentConfig);
  } catch (e) {
    errorRed(
      `Agent config is invalid, this is possibly due to required contracts not being deployed. See details below:\n${fromError(
        e,
      ).toString()}`,
    );
    process.exit(1);
  }

  logBlue(`Agent config is valid, writing to file ${out}`);
  writeYamlOrJson(out, agentConfig, 'json');
  logGreen(`✅ Agent config successfully written to ${out}`);
}
