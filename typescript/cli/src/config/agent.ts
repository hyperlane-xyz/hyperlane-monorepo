import {
  ChainMap,
  HyperlaneCore,
  HyperlaneDeploymentArtifacts,
  buildAgentConfig,
} from '@hyperlane-xyz/sdk';
import { objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import { ChainType } from '../commands/registry.js';
import { CommandContext } from '../context/types.js';
import { logBlue, logGreen, warnYellow } from '../logger.js';
import { writeYamlOrJson } from '../utils/files.js';

export async function createAgentConfig({
  context,
  chains,
  environment,
  out,
}: {
  context: CommandContext;
  chains?: string[];
  environment?: ChainType;
  out: string;
}) {
  logBlue(`\nCreating agent config...`);

  const { registry, multiProvider, chainMetadata } = context;
  const addresses = await registry.getAddresses();

  let agentChains;
  if (chains) {
    agentChains = chains;
  } else {
    const metadata = Object.values(chainMetadata).filter((c) => {
      if (environment === 'mainnet') return !c.isTestnet;
      else return !!c.isTestnet;
    });
    agentChains = metadata.map((c) => c.name);
  }

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
        // TODO: how to this in the CLI? should this be surfaced to the user as a warning, should it require an interaction?
        warnYellow(
          `Failed to get deployed block, defaulting to 0 for index for ${chain}`,
        );
        return 0;
      }
    }),
  );

  // TODO: consider adding additional config used to pass in gas prices for Cosmos chains
  const agentConfig = buildAgentConfig(
    agentChains,
    multiProvider,
    addresses as ChainMap<HyperlaneDeploymentArtifacts>,
    startBlocks,
  );

  writeYamlOrJson(out, agentConfig);
  logGreen(`Agent config successfully written to ${out}`);
}
