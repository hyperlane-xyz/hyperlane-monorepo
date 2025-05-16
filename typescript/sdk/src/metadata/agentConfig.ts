/**
 * The types defined here are the source of truth for chain metadata.
 * ANY CHANGES HERE NEED TO BE REFLECTED IN HYPERLANE-BASE CONFIG PARSING.
 */
import { z } from 'zod';

import { ModuleType } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainMap, ChainName } from '../types.js';

import { ChainMetadataSchemaObject } from './chainMetadataTypes.js';
import { ZHash, ZNzUint, ZUWei, ZUint } from './customZodTypes.js';
import {
  HyperlaneDeploymentArtifacts,
  HyperlaneDeploymentArtifactsSchema,
} from './deploymentArtifacts.js';
import { MatchingListSchema } from './matchingList.js';

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
  Cosmos = 'cosmosKey',
  Starknet = 'starkKey',
}

export enum AgentSealevelPriorityFeeOracleType {
  Helius = 'helius',
  Constant = 'constant',
}

export enum AgentSealevelHeliusFeeLevel {
  Recommended = 'recommended',
  Min = 'min',
  Low = 'low',
  Medium = 'medium',
  High = 'high',
  VeryHigh = 'veryHigh',
  UnsafeMax = 'unsafeMax',
}

export enum AgentSealevelTransactionSubmitterType {
  Rpc = 'rpc',
  Jito = 'jito',
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
const AgentSignerCosmosKeySchema = z
  .object({
    type: z.literal(AgentSignerKeyType.Cosmos),
    prefix: z.string().describe('The bech32 prefix for the cosmos address'),
    key: ZHash,
  })
  .describe('Cosmos key');
const AgentSignerNodeSchema = z
  .object({
    type: z.literal(AgentSignerKeyType.Node),
  })
  .describe('Assume the local node will sign on RPC calls automatically');

const AgentSignerSchema = z.union([
  AgentSignerHexKeySchema,
  AgentSignerAwsKeySchema,
  AgentSignerCosmosKeySchema,
  AgentSignerNodeSchema,
]);

export type AgentSignerHexKey = z.infer<typeof AgentSignerHexKeySchema>;
export type AgentSignerAwsKey = z.infer<typeof AgentSignerAwsKeySchema>;
export type AgentSignerCosmosKey = z.infer<typeof AgentSignerNodeSchema>;
export type AgentSignerNode = z.infer<typeof AgentSignerNodeSchema>;
export type AgentSigner = z.infer<typeof AgentSignerSchema>;

// Additional chain metadata for Cosmos chains required by the agents.
const AgentCosmosChainMetadataSchema = z.object({
  canonicalAsset: z
    .string()
    .describe(
      'The name of the canonical asset for this chain, usually in "micro" form, e.g. untrn',
    ),
  gasPrice: z.object({
    denom: z
      .string()
      .describe('The coin denom, usually in "micro" form, e.g. untrn'),
    amount: z
      .string()
      .regex(/^(\d*[.])?\d+$/)
      .describe('The gas price, in denom, to pay for each unit of gas'),
  }),
  contractAddressBytes: z
    .number()
    .int()
    .positive()
    .lte(32)
    .describe('The number of bytes used to represent a contract address.'),
});

export type AgentCosmosGasPrice = z.infer<
  typeof AgentCosmosChainMetadataSchema
>['gasPrice'];

const AgentSealevelChainMetadataSchema = z.object({
  priorityFeeOracle: z
    .union([
      z.object({
        type: z.literal(AgentSealevelPriorityFeeOracleType.Helius),
        url: z.string(),
        // TODO add options
        feeLevel: z.nativeEnum(AgentSealevelHeliusFeeLevel),
      }),
      z.object({
        type: z.literal(AgentSealevelPriorityFeeOracleType.Constant),
        // In microlamports
        fee: ZUWei,
      }),
    ])
    .optional(),
  transactionSubmitter: z
    .object({
      type: z.nativeEnum(AgentSealevelTransactionSubmitterType),
      url: z.string().optional(),
    })
    .optional(),
});

export type AgentSealevelChainMetadata = z.infer<
  typeof AgentSealevelChainMetadataSchema
>;

export type AgentSealevelPriorityFeeOracle =
  AgentSealevelChainMetadata['priorityFeeOracle'];

export type AgentSealevelTransactionSubmitter =
  AgentSealevelChainMetadata['transactionSubmitter'];

export const AgentChainMetadataSchema = ChainMetadataSchemaObject.merge(
  HyperlaneDeploymentArtifactsSchema,
)
  .extend({
    customRpcUrls: z
      .string()
      .optional()
      .describe(
        'Specify a comma separated list of custom RPC URLs to use for this chain. If not specified, the default RPC urls will be used.',
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
  })
  .merge(AgentCosmosChainMetadataSchema.partial())
  .merge(AgentSealevelChainMetadataSchema.partial())
  .refine((metadata) => {
    // Make sure that the signer is valid for the protocol

    const signerType = metadata.signer?.type;

    // If no signer is specified, no validation is needed
    if (signerType === undefined) {
      return true;
    }

    switch (metadata.protocol) {
      case ProtocolType.Ethereum:
        if (
          ![
            AgentSignerKeyType.Hex,
            signerType === AgentSignerKeyType.Aws,
            signerType === AgentSignerKeyType.Node,
          ].includes(signerType)
        ) {
          return false;
        }
        break;

      case ProtocolType.Cosmos:
      case ProtocolType.CosmosNative:
        if (![AgentSignerKeyType.Cosmos].includes(signerType)) {
          return false;
        }
        break;

      case ProtocolType.Sealevel:
        if (![AgentSignerKeyType.Hex].includes(signerType)) {
          return false;
        }
        break;

      default:
      // Just accept it if we don't know the protocol
    }

    // If the protocol type is Cosmos, require everything in AgentCosmosChainMetadataSchema
    if (
      metadata.protocol === ProtocolType.Cosmos ||
      metadata.protocol === ProtocolType.CosmosNative
    ) {
      if (!AgentCosmosChainMetadataSchema.safeParse(metadata).success) {
        return false;
      }
    }

    // If the protocol type is Sealevel, require everything in AgentSealevelChainMetadataSchema
    if (metadata.protocol === ProtocolType.Sealevel) {
      if (!AgentSealevelChainMetadataSchema.safeParse(metadata).success) {
        return false;
      }
    }

    return true;
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

const CommaSeparatedChainList = z.string().regex(/^[a-z0-9]+(,[a-z0-9]+)*$/);
const CommaSeparatedDomainList = z.string().regex(/^\d+(,\d+)*$/);

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

const MetricAppContextSchema = z.object({
  name: z.string().min(1),
  matchingList: MatchingListSchema.describe(
    'A matching list, any message that matches will be classified as this app context.',
  ),
});

export enum IsmCachePolicy {
  MessageSpecific = 'messageSpecific',
  IsmSpecific = 'ismSpecific',
}

export enum IsmCacheSelectorType {
  DefaultIsm = 'defaultIsm',
  AppContext = 'appContext',
}

const IsmCacheSelector = z.discriminatedUnion('type', [
  z.object({
    type: z.literal(IsmCacheSelectorType.DefaultIsm),
  }),
  z.object({
    type: z.literal(IsmCacheSelectorType.AppContext),
    context: z.string(),
  }),
]);

const IsmCacheConfigSchema = z.object({
  selector: IsmCacheSelector.describe(
    'The selector to use for the ISM cache policy',
  ),
  moduleTypes: z
    .array(z.nativeEnum(ModuleType))
    .describe('The ISM module types to use the cache policy for.'),
  chains: z
    .array(z.string())
    .optional()
    .describe(
      'The chains to use the cache policy for. If not specified, all chains will be used.',
    ),
  cachePolicy: z
    .nativeEnum(IsmCachePolicy)
    .describe('The cache policy to use.'),
});
export type IsmCacheConfig = z.infer<typeof IsmCacheConfigSchema>;

export const RelayerAgentConfigSchema = AgentConfigSchema.extend({
  db: z
    .string()
    .min(1)
    .optional()
    .describe('The path to the relayer database.'),
  relayChains: CommaSeparatedChainList.describe(
    'Comma separated list of chains to relay messages between.',
  ),
  gasPaymentEnforcement: z
    .union([z.array(GasPaymentEnforcementSchema), z.string().min(1)])
    .optional()
    .describe(
      'The gas payment enforcement configuration as JSON. Expects an ordered array of `GasPaymentEnforcementConfig`.',
    ),
  whitelist: z
    .union([MatchingListSchema, z.string().min(1)])
    .optional()
    .describe(
      'If no whitelist is provided ALL messages will be considered on the whitelist.',
    ),
  blacklist: z
    .union([MatchingListSchema, z.string().min(1)])
    .optional()
    .describe(
      'If no blacklist is provided ALL will be considered to not be on the blacklist.',
    ),
  addressBlacklist: z
    .string()
    .optional()
    .describe('Comma separated list of addresses to blacklist.'),
  transactionGasLimit: ZUWei.optional().describe(
    'This is optional. If not specified, any amount of gas will be valid, otherwise this is the max allowed gas in wei to relay a transaction.',
  ),
  skipTransactionGasLimitFor: CommaSeparatedDomainList.optional().describe(
    'Comma separated List of chain names to skip applying the transaction gas limit to.',
  ),
  allowLocalCheckpointSyncers: z
    .boolean()
    .optional()
    .describe(
      'If true, allows local storage based checkpoint syncers. Not intended for production use.',
    ),
  metricAppContexts: z
    .union([z.array(MetricAppContextSchema), z.string().min(1)])
    .optional()
    .describe(
      'A list of app contexts and their matching lists to use for metrics. A message will be classified as the first matching app context.',
    ),
  ismCacheConfigs: z
    .union([z.array(IsmCacheConfigSchema), z.string().min(1)])
    .optional()
    .describe(
      'The ISM cache configs to be used. If not specified, default caching will be used.',
    ),
  allowContractCallCaching: z
    .boolean()
    .optional()
    .describe(
      'If true, allows caching of certain contract calls that can be appropriately cached.',
    ),
  txIdIndexingEnabled: z
    .boolean()
    .optional()
    .describe(
      'Whether to enable TX ID based indexing for hook events given indexed messages',
    ),
  igpIndexingEnabled: z
    .boolean()
    .optional()
    .describe('Whether to enable IGP indexing'),
});

export type RelayerConfig = z.infer<typeof RelayerAgentConfigSchema>;

export const ScraperAgentConfigSchema = AgentConfigSchema.extend({
  db: z.string().min(1).describe('Database connection string'),
  chainsToScrape: CommaSeparatedChainList.describe(
    'Comma separated list of chain names to scrape',
  ),
});

export type ScraperConfig = z.infer<typeof ScraperAgentConfigSchema>;

export const ValidatorAgentConfigSchema = AgentConfigSchema.extend({
  db: z
    .string()
    .min(1)
    .optional()
    .describe('The path to the validator database.'),
  originChainName: z
    .string()
    .min(1)
    .describe('Name of the chain to validate messages on'),
  validator: AgentSignerSchema.describe('The validator attestation signer'),
  checkpointSyncer: z.discriminatedUnion('type', [
    z
      .object({
        type: z.literal('localStorage'),
        path: z.string().min(1).describe('Path to the local storage location'),
      })
      .describe('A local checkpoint syncer'),
    z
      .object({
        type: z.literal('s3'),
        bucket: z.string().min(1),
        region: z.string().min(1),
        folder: z
          .string()
          .min(1)
          .optional()
          .describe(
            'The folder/key-prefix to use, defaults to the root of the bucket',
          ),
      })
      .describe('A checkpoint syncer that uses S3'),
    z
      .object({
        type: z.literal('gcs'),
        bucket: z.string().min(1),
        folder: z
          .string()
          .min(1)
          .optional()
          .describe('The folder to use, defaults to the root of the bucket'),
        service_account_key: z
          .string()
          .min(1)
          .optional()
          .describe('The path to GCS service account key file'),
        user_secrets: z
          .string()
          .min(1)
          .optional()
          .describe('The path to GCS user secret file'),
      })
      .describe('A checkpoint syncer that uses Google Cloud Storage'),
  ]),
  interval: ZUint.optional().describe(
    'How long to wait between checking for new checkpoints in seconds.',
  ),
});

export type ValidatorConfig = z.infer<typeof ValidatorAgentConfigSchema>;

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// Note this works well for EVM chains only, and likely needs some love
// before being useful for non-EVM chains.
export function buildAgentConfig(
  chains: ChainName[],
  multiProvider: MultiProvider,
  addresses: ChainMap<HyperlaneDeploymentArtifacts>,
  startBlocks: ChainMap<number | undefined>,
  additionalConfig?: ChainMap<any>,
): AgentConfig {
  const chainConfigs: ChainMap<AgentChainMetadata> = {};
  for (const chain of [...chains].sort()) {
    const metadata = multiProvider.tryGetChainMetadata(chain);
    // Cosmos Native chains have the correct gRPC URL format in the registry. So only delete the gRPC URL for legacy Cosmos chains.
    if (metadata?.protocol === ProtocolType.Cosmos) {
      // Note: the gRPC URL format in the registry lacks a correct http:// or https:// prefix at the moment,
      // which is expected by the agents. For now, we intentionally skip this.
      delete metadata.grpcUrls;
    }

    // Delete transaction overrides for all Cosmos chains.
    if (
      metadata?.protocol === ProtocolType.Cosmos ||
      metadata?.protocol === ProtocolType.CosmosNative
    ) {
      // The agents expect gasPrice.amount and gasPrice.denom and ignore the transaction overrides.
      // To reduce confusion when looking at the config, we remove the transaction overrides.
      delete metadata.transactionOverrides;
    }

    const chainConfig: AgentChainMetadata = {
      ...metadata,
      ...addresses[chain],
      ...(additionalConfig ? additionalConfig[chain] : {}),
      ...(startBlocks[chain] !== undefined && {
        index: {
          from: startBlocks[chain],
        },
      }),
    };
    chainConfigs[chain] = chainConfig;
  }

  return {
    chains: chainConfigs,
    defaultRpcConsensusType: RpcConsensusType.Fallback,
  };
}
