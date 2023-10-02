/**
 * The types defined here are the source of truth for chain metadata.
 * ANY CHANGES HERE NEED TO BE REFLECTED IN HYPERLANE-BASE CONFIG PARSING.
 */
import { z } from 'zod';

import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import { ChainMetadata, ChainMetadataSchema } from './chainMetadataTypes';
import { ZHash, ZNzUint, ZUWei, ZUint } from './customZodTypes';
import {
  HyperlaneDeploymentArtifacts,
  HyperlaneDeploymentArtifactsSchema,
} from './deploymentArtifacts';
import { MatchingListSchema } from './matchingList';

export enum RpcConsensusType {
  Single = 'single',
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

export enum AgentSignerKeyType {
  Aws = 'aws',
  Hex = 'hexKey',
  Node = 'node',
}

const AgentSignerHexKeySchema = z
  .object({
    type: z.literal(AgentSignerKeyType.Hex).optional(),
    key: ZHash,
  })
  .describe('A local hex key');
const AgentSignerAwsKeySchema = z
  .object({
    type: z.literal(AgentSignerKeyType.Aws).optional(),
    id: z.string().describe('The UUID identifying the AWS KMS key'),
    region: z.string().describe('The AWS region'),
  })
  .describe(
    'An AWS signer. Note that AWS credentials must be inserted into the env separately.',
  );
const AgentSignerNodeSchema = z
  .object({
    type: z.literal(AgentSignerKeyType.Node),
  })
  .describe('Assume the local node will sign on RPC calls automatically');

const AgentSignerSchema = z.union([
  AgentSignerHexKeySchema,
  AgentSignerAwsKeySchema,
  AgentSignerNodeSchema,
]);

export type AgentSignerHexKey = z.infer<typeof AgentSignerHexKeySchema>;
export type AgentSignerAwsKey = z.infer<typeof AgentSignerAwsKeySchema>;
export type AgentSignerNode = z.infer<typeof AgentSignerNodeSchema>;
export type AgentSigner = z.infer<typeof AgentSignerSchema>;

export const AgentChainMetadataSchema = ChainMetadataSchema.merge(
  HyperlaneDeploymentArtifactsSchema,
).extend({
  customRpcUrls: z
    .string()
    .optional()
    .describe(
      'Specify a comma seperated list of custom RPC URLs to use for this chain. If not specified, the default RPC urls will be used.',
    ),
  rpcConsensusType: z
    .nativeEnum(RpcConsensusType)
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
    .nativeEnum(RpcConsensusType)
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

export enum GasPaymentEnforcementPolicyType {
  None = 'none',
  Minimum = 'minimum',
  OnChainFeeQuoting = 'onChainFeeQuoting',
}

const GasPaymentEnforcementBaseSchema = z.object({
  matchingList: MatchingListSchema.optional().describe(
    'An optional matching list, any message that matches will use this policy. By default all messages will match.',
  ),
});
const GasPaymentEnforcementSchema = z.union([
  GasPaymentEnforcementBaseSchema.extend({
    type: z.literal(GasPaymentEnforcementPolicyType.None).optional(),
  }),
  GasPaymentEnforcementBaseSchema.extend({
    type: z.literal(GasPaymentEnforcementPolicyType.Minimum).optional(),
    payment: ZUWei,
  }),
  GasPaymentEnforcementBaseSchema.extend({
    type: z.literal(GasPaymentEnforcementPolicyType.OnChainFeeQuoting),
    gasFraction: z
      .string()
      .regex(/^\d+ ?\/ ?[1-9]\d*$/)
      .optional(),
  }),
]);
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
    .union([z.array(GasPaymentEnforcementSchema), z.string().nonempty()])
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

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export function buildAgentConfig(
  chains: ChainName[],
  multiProvider: MultiProvider,
  addresses: ChainMap<HyperlaneDeploymentArtifacts>,
  startBlocks: ChainMap<number>,
): AgentConfig {
  const chainConfigs: ChainMap<AgentChainMetadata> = {};
  for (const chain of [...chains].sort()) {
    const metadata: ChainMetadata = multiProvider.getChainMetadata(chain);
    const chainConfig: AgentChainMetadata = {
      ...metadata,
      ...addresses[chain],
      index: {
        from: startBlocks[chain],
      },
    };
    chainConfigs[chain] = chainConfig;
  }

  return {
    chains: chainConfigs,
    defaultRpcConsensusType: RpcConsensusType.Fallback,
  };
}
