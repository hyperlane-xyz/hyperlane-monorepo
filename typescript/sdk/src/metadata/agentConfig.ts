/**
 * The types defined here are the source of truth for chain metadata.
 * ANY CHANGES HERE NEED TO BE REFLECTED IN HYPERLANE-BASE CONFIG PARSING.
 */
import { z } from 'zod';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import {
  ChainMetadata,
  ChainMetadataSchema,
  RpcUrlSchema,
} from './chainMetadataTypes';
import { ZHash, ZNzUint, ZUWei, ZUint } from './customZodTypes';
import {
  HyperlaneDeploymentArtifacts,
  HyperlaneDeploymentArtifactsSchema,
} from './deploymentArtifacts';
import { MatchingListSchema } from './matchingList';

export enum AgentConnectionType {
  Http = 'http',
  Ws = 'ws',
  HttpQuorum = 'httpQuorum',
  HttpFallback = 'httpFallback',
}

export enum AgentConsensusType {
  Fallback = 'fallback',
  Quorum = 'quorum',
}

export enum AgentLogLevel {
  Off = 'off',
  Error = 'error',
  Warn = 'warn',
  Info = 'info',
  Debug = 'debug',
  Trace = 'trace',
}

export enum AgentLogFormat {
  Json = 'json',
  Compact = 'compact',
  Full = 'full',
  Pretty = 'pretty',
}

export enum AgentIndexMode {
  Block = 'block',
  Sequence = 'sequence',
}

export const AgentSignerSchema = z.union([
  z
    .object({
      type: z.literal('hexKey').optional(),
      key: ZHash,
    })
    .describe('A local hex key'),
  z
    .object({
      type: z.literal('aws').optional(),
      id: z.string().describe('The UUID identifying the AWS KMS key'),
      region: z.string().describe('The AWS region'),
    })
    .describe(
      'An AWS signer. Note that AWS credentials must be inserted into the env separately.',
    ),
  z
    .object({
      type: z.literal('node'),
    })
    .describe('Assume the local node will sign on RPC calls automatically'),
]);

export type AgentSignerV2 = z.infer<typeof AgentSignerSchema>;

export const AgentChainMetadataSchema = ChainMetadataSchema.merge(
  HyperlaneDeploymentArtifactsSchema,
).extend({
  customRpcUrls: z
    .record(
      RpcUrlSchema.extend({
        priority: ZNzUint.optional().describe(
          'The priority of this RPC relative to the others defined. A larger value means it will be preferred. Only effects some AgentConsensusTypes.',
        ),
      }),
    )
    .refine((data) => Object.keys(data).length > 0, {
      message:
        'Must specify at least one RPC url if not using the default rpcUrls.',
    })
    .optional()
    .describe(
      'Specify a custom RPC endpoint configuration for this chain. If this is set, then none of the `rpcUrls` will be used for this chain. The key value can be any valid string.',
    ),
  rpcConsensusType: z
    .nativeEnum(AgentConsensusType)
    .describe('The consensus type to use when multiple RPCs are configured.')
    .optional(),
  signer: AgentSignerSchema.optional().describe(
    'The signer to use for this chain',
  ),
  index: z
    .object({
      from: ZUint.optional().describe(
        'The starting block from which to index events.',
      ),
      chunk: ZNzUint.optional().describe(
        'The number of blocks to index at a time.',
      ),
      // TODO(2214): I think we can always interpret this from the ProtocolType
      mode: z
        .nativeEnum(AgentIndexMode)
        .optional()
        .describe(
          'The indexing method to use for this chain; will attempt to choose a suitable default if not specified.',
        ),
    })
    .optional(),
});

export type AgentChainMetadata = z.infer<typeof AgentChainMetadataSchema>;

export const AgentConfigSchema = z.object({
  metricsPort: ZNzUint.lte(65535)
    .optional()
    .describe(
      'The port to expose prometheus metrics on. Accessible via `GET /metrics`.',
    ),
  chains: z
    .record(AgentChainMetadataSchema)
    .describe('Chain metadata for all chains that the agent will index.')
    .superRefine((data, ctx) => {
      for (const c in data) {
        if (c != data[c].name) {
          ctx.addIssue({
            message: `Chain name ${c} does not match chain name in metadata ${data[c].name}`,
            code: z.ZodIssueCode.custom,
          });
        }
      }
    }),
  defaultSigner: AgentSignerSchema.optional().describe(
    'Default signer to use for any chains that have not defined their own.',
  ),
  defaultRpcConsensusType: z
    .nativeEnum(AgentConsensusType)
    .describe(
      'The default consensus type to use for any chains that have not defined their own.',
    )
    .optional(),
  log: z
    .object({
      format: z
        .nativeEnum(AgentLogFormat)
        .optional()
        .describe('The format to use for tracing logs.'),
      level: z
        .nativeEnum(AgentLogLevel)
        .optional()
        .describe("The log level to use for the agent's logs."),
    })
    .optional(),
});

const CommaSeperatedChainList = z.string().regex(/^[a-z0-9]+(,[a-z0-9]+)*$/);
const CommaSeperatedDomainList = z.string().regex(/^\d+(,\d+)*$/);

const GasPaymentEnforcementBaseSchema = z.object({
  matchingList: MatchingListSchema.optional().describe(
    'An optional matching list, any message that matches will use this policy. By default all messages will match.',
  ),
});
const GasPaymentEnforcementSchema = z.array(
  z.union([
    GasPaymentEnforcementBaseSchema.extend({
      type: z.literal('none').optional(),
    }),
    GasPaymentEnforcementBaseSchema.extend({
      type: z.literal('minimum').optional(),
      payment: ZUWei,
    }),
    GasPaymentEnforcementBaseSchema.extend({
      type: z.literal('onChainFeeQuoting'),
      gasFraction: z
        .string()
        .regex(/^\d+ ?\/ ?[1-9]\d*$/)
        .optional(),
    }),
  ]),
);

export type GasPaymentEnforcement = z.infer<typeof GasPaymentEnforcementSchema>;

export const RelayerAgentConfigSchema = AgentConfigSchema.extend({
  db: z
    .string()
    .nonempty()
    .optional()
    .describe('The path to the relayer database.'),
  relayChains: CommaSeperatedChainList.describe(
    'Comma seperated list of chains to relay messages between.',
  ),
  gasPaymentEnforcement: z
    .union([GasPaymentEnforcementSchema, z.string().nonempty()])
    .optional()
    .describe(
      'The gas payment enforcement configuration as JSON. Expects an ordered array of `GasPaymentEnforcementConfig`.',
    ),
  whitelist: z
    .union([MatchingListSchema, z.string().nonempty()])
    .optional()
    .describe(
      'If no whitelist is provided ALL messages will be considered on the whitelist.',
    ),
  blacklist: z
    .union([MatchingListSchema, z.string().nonempty()])
    .optional()
    .describe(
      'If no blacklist is provided ALL will be considered to not be on the blacklist.',
    ),
  transactionGasLimit: ZUWei.optional().describe(
    'This is optional. If not specified, any amount of gas will be valid, otherwise this is the max allowed gas in wei to relay a transaction.',
  ),
  skipTransactionGasLimitFor: CommaSeperatedDomainList.optional().describe(
    'Comma separated List of chain names to skip applying the transaction gas limit to.',
  ),
  allowLocalCheckpointSyncers: z
    .boolean()
    .optional()
    .describe(
      'If true, allows local storage based checkpoint syncers. Not intended for production use.',
    ),
});

export type RelayerConfig = z.infer<typeof RelayerAgentConfigSchema>;

export const ScraperAgentConfigSchema = AgentConfigSchema.extend({
  db: z.string().nonempty().describe('Database connection string'),
  chainsToScrape: CommaSeperatedChainList.describe(
    'Comma separated list of chain names to scrape',
  ),
});

export type ScraperConfig = z.infer<typeof ScraperAgentConfigSchema>;

export const ValidatorAgentConfigSchema = AgentConfigSchema.extend({
  db: z
    .string()
    .nonempty()
    .optional()
    .describe('The path to the validator database.'),
  originChainName: z
    .string()
    .nonempty()
    .describe('Name of the chain to validate messages on'),
  validator: AgentSignerSchema.describe('The validator attestation signer'),
  checkpointSyncer: z.discriminatedUnion('type', [
    z
      .object({
        type: z.literal('localStorage'),
        path: z
          .string()
          .nonempty()
          .describe('Path to the local storage location'),
      })
      .describe('A local checkpoint syncer'),
    z
      .object({
        type: z.literal('s3'),
        bucket: z.string().nonempty(),
        region: z.string().nonempty(),
        folder: z
          .string()
          .nonempty()
          .optional()
          .describe(
            'The folder/key-prefix to use, defaults to the root of the bucket',
          ),
      })
      .describe('A checkpoint syncer that uses S3'),
  ]),
  interval: ZUint.optional().describe(
    'How long to wait between checking for new checkpoints in seconds.',
  ),
});

export type ValidatorConfig = z.infer<typeof ValidatorAgentConfigSchema>;

export type AgentConfigV2 = z.infer<typeof AgentConfigSchema>;

/**
 * Deprecated agent config shapes.
 * See https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/2215
 */

export interface AgentSigner {
  key: string;
  type: string;
}

export type AgentConnection =
  | { type: AgentConnectionType.Http; url: string }
  | { type: AgentConnectionType.Ws; url: string }
  | { type: AgentConnectionType.HttpQuorum; urls: string }
  | { type: AgentConnectionType.HttpFallback; urls: string };

export interface AgentChainSetupBase {
  name: ChainName;
  domain: number;
  signer?: AgentSigner;
  finalityBlocks: number;
  addresses: HyperlaneDeploymentArtifacts;
  protocol: ProtocolType;
  connection?: AgentConnection;
  index?: { from: number };
}

export interface AgentChainSetup extends AgentChainSetupBase {
  signer: AgentSigner;
  connection: AgentConnection;
}

export interface AgentConfig {
  chains: Partial<ChainMap<AgentChainSetupBase>>;
  tracing?: {
    level?: string;
    fmt?: 'json';
  };
}

/**
 * Utilities for generating agent configs from metadata / artifacts.
 */

// Returns the new agent config shape that extends ChainMetadata
export function buildAgentConfigNew(
  chains: ChainName[],
  multiProvider: MultiProvider,
  addresses: ChainMap<HyperlaneDeploymentArtifacts>,
  startBlocks: ChainMap<number>,
): ChainMap<AgentChainMetadata> {
  const configs: ChainMap<AgentChainMetadata> = {};
  for (const chain of [...chains].sort()) {
    const metadata: ChainMetadata = multiProvider.getChainMetadata(chain);
    const config: AgentChainMetadata = {
      ...metadata,
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

// Returns the current (but deprecated) agent config shape.
export function buildAgentConfigDeprecated(
  chains: ChainName[],
  multiProvider: MultiProvider,
  addresses: ChainMap<HyperlaneDeploymentArtifacts>,
  startBlocks: ChainMap<number>,
): AgentConfig {
  const agentConfig: AgentConfig = {
    chains: {},
  };

  for (const chain of [...chains].sort()) {
    const metadata = multiProvider.getChainMetadata(chain);
    const chainConfig: AgentChainSetupBase = {
      name: chain,
      domain: metadata.chainId,
      addresses: {
        mailbox: addresses[chain].mailbox,
        interchainGasPaymaster: addresses[chain].interchainGasPaymaster,
        validatorAnnounce: addresses[chain].validatorAnnounce,
      },
      protocol: metadata.protocol,
      finalityBlocks: metadata.blocks?.reorgPeriod ?? 1,
    };

    chainConfig.index = {
      from: startBlocks[chain],
    };

    agentConfig.chains[chain] = chainConfig;
  }
  return agentConfig;
}

// TODO(2215): this eventually needs to to be replaced with just `AgentConfig2` (and that ident needs renaming)
export type CombinedAgentConfig = AgentConfigV2['chains'] | AgentConfig;

export function buildAgentConfig(
  chains: ChainName[],
  multiProvider: MultiProvider,
  addresses: ChainMap<HyperlaneDeploymentArtifacts>,
  startBlocks: ChainMap<number>,
): CombinedAgentConfig {
  return {
    ...buildAgentConfigNew(chains, multiProvider, addresses, startBlocks),
    ...buildAgentConfigDeprecated(
      chains,
      multiProvider,
      addresses,
      startBlocks,
    ),
  };
}
