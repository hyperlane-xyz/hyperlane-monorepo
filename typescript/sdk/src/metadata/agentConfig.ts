import { z } from 'zod';

import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import {
  ChainMetadataWithArtifactsSchema,
  HyperlaneDeploymentArtifacts,
} from './deploymentArtifacts';

export enum AgentConnectionType {
  Http = 'http',
  Ws = 'ws',
  HttpQuorum = 'httpQuorum',
  HttpFallback = 'httpFallback',
}

export const AgentMetadataExtSchema = z.object({
  rpcConsensusType: z
    .nativeEnum(AgentConnectionType)
    .default(AgentConnectionType.HttpFallback)
    .describe(
      'The consensus type to use when multiple RPCs are configured. `fallback` will use the first RPC that returns a result, `quorum` will require a majority of RPCs to return the same result. Different consumers may choose to default to different values here, i.e. validators may want to default to `quorum` while relayers may want to default to `fallback`.',
    ),
  overrideRpcUrls: z
    .string()
    .optional()
    .describe(
      'Used to allow for a comma-separated list of RPC URLs to be specified without a complex `path` in the agent configuration scheme. Agents should check for the existence of this field first and use that in conjunction with `rpcConsensusType` if it exists, otherwise fall back to `rpcUrls`.',
    ),
  index: z.object({
    from: z
      .number()
      .default(1999)
      .optional()
      .describe('The starting block from which to index events.'),
    chunk: z
      .number()
      .default(1000)
      .optional()
      .describe('The number of blocks to index per chunk.'),
  }),
});

export type AgentMetadataExtension = z.infer<typeof AgentMetadataExtSchema>;

export const ChainMetadataForAgentSchema =
  ChainMetadataWithArtifactsSchema.merge(AgentMetadataExtSchema);

export type ChainMetadataForAgent = z.infer<typeof ChainMetadataForAgentSchema>;

export function buildAgentConfig(
  chains: ChainName[],
  multiProvider: MultiProvider,
  addresses: ChainMap<HyperlaneDeploymentArtifacts>,
  startBlocks: ChainMap<number>,
): ChainMap<ChainMetadataForAgent> {
  const configs: ChainMap<ChainMetadataForAgent> = {};
  for (const chain of [...chains].sort()) {
    const metadata = multiProvider.getChainMetadata(chain);
    const config: ChainMetadataForAgent = {
      ...metadata,
      rpcConsensusType: AgentConnectionType.HttpFallback,
      mailbox: addresses[chain].mailbox,
      interchainGasPaymaster: addresses[chain].interchainGasPaymaster,
      validatorAnnounce: addresses[chain].validatorAnnounce,
      index: {
        from: startBlocks[chain],
      },
    };
    configs[chain] = config;
  }
  return configs;
}
