/**
 * The types defined here are the source of truth for chain metadata.
 * ANY CHANGES HERE NEED TO BE REFLECTED IN HYPERLANE-BASE CONFIG PARSING.
 */
import { SafeParseReturnType, z } from 'zod';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { ZChainName, ZNzUint, ZUint } from './customZodTypes.js';

export enum ExplorerFamily {
  Etherscan = 'etherscan',
  Blockscout = 'blockscout',
  Routescan = 'routescan',
  Other = 'other',
}

export enum ChainTechnicalStack {
  ArbitrumNitro = 'arbitrumnitro',
  Other = 'other',
}

// A type that also allows for literal values of the enum
export type ExplorerFamilyValue = `${ExplorerFamily}`;

export const RpcUrlSchema = z.object({
  http: z
    .string()
    .url()
    .describe('The HTTP URL of the RPC endpoint (preferably HTTPS).'),
  webSocket: z
    .string()
    .optional()
    .describe('The WSS URL if the endpoint also supports websockets.'),
  pagination: z
    .object({
      maxBlockRange: ZNzUint.optional().describe(
        'The maximum range between block numbers for which the RPC can query data',
      ),
      minBlockNumber: ZUint.optional().describe(
        'The absolute minimum block number that this RPC supports.',
      ),
      maxBlockAge: ZNzUint.optional().describe(
        'The relative different from latest block that this RPC supports.',
      ),
    })
    .optional()
    .describe('Limitations on the block range/age that can be queried.'),
  retry: z
    .object({
      maxRequests: ZNzUint.describe(
        'The maximum number of requests to attempt before failing.',
      ),
      baseRetryMs: ZNzUint.describe('The base retry delay in milliseconds.'),
    })
    .optional()
    .describe(
      'Default retry settings to be used by a provider such as MultiProvider.',
    ),
});

export type RpcUrl = z.infer<typeof RpcUrlSchema>;

/**
 * A collection of useful properties and settings for chains using Hyperlane
 * Specified as a Zod schema
 */
export const ChainMetadataSchemaObject = z.object({
  name: ZChainName.describe(
    'The unique string identifier of the chain, used as the key in ChainMap dictionaries.',
  ),
  protocol: z
    .nativeEnum(ProtocolType)
    .describe(
      'The type of protocol used by this chain. See ProtocolType for valid values.',
    ),
  chainId: z
    .union([ZNzUint, z.string()])
    .describe(`The chainId of the chain. Uses EIP-155 for EVM chains`),
  domainId: ZNzUint.optional().describe(
    'The domainId of the chain, should generally default to `chainId`. Consumer of `ChainMetadata` should use this value if present, but otherwise fallback to `chainId`.',
  ),
  displayName: z
    .string()
    .optional()
    .describe('Human-readable name of the chain.'),
  displayNameShort: z
    .string()
    .optional()
    .describe(
      'A shorter human-readable name of the chain for use in user interfaces.',
    ),
  technicalStack: z
    .nativeEnum(ChainTechnicalStack)
    .optional()
    .describe(
      'The technical stack of the chain. See ChainTechnicalStack for valid values.',
    ),
  logoURI: z
    .string()
    .optional()
    .describe(
      'A URI to a logo image for this chain for use in user interfaces.',
    ),
  nativeToken: z
    .object({
      name: z.string(),
      symbol: z.string(),
      decimals: ZUint.lt(256),
      denom: z.string().optional(),
    })
    .optional()
    .describe(
      'The metadata of the native token of the chain (e.g. ETH for Ethereum).',
    ),
  rpcUrls: z
    .array(RpcUrlSchema)
    .nonempty()
    .describe('The list of RPC endpoints for interacting with the chain.'),
  restUrls: z
    .array(RpcUrlSchema)
    .describe('For cosmos chains only, a list of Rest API URLs')
    .optional(),
  grpcUrls: z
    .array(RpcUrlSchema)
    .describe('For cosmos chains only, a list of gRPC API URLs')
    .optional(),
  customGrpcUrls: z
    .string()
    .optional()
    .describe(
      'Specify a comma separated list of custom GRPC URLs to use for this chain. If not specified, the default GRPC urls will be used.',
    ),
  blockExplorers: z
    .array(
      z.object({
        name: z.string().describe('A human readable name for the explorer.'),
        url: z.string().url().describe('The base URL for the explorer.'),
        apiUrl: z
          .string()
          .url()
          .describe('The base URL for requests to the explorer API.'),
        apiKey: z
          .string()
          .optional()
          .describe(
            'An API key for the explorer (recommended for better reliability).',
          ),
        family: z
          .nativeEnum(ExplorerFamily)
          .optional()
          .describe(
            'The type of the block explorer. See ExplorerFamily for valid values.',
          ),
      }),
    )
    .optional()
    .describe('A list of block explorers with data for this chain'),
  blocks: z
    .object({
      confirmations: ZUint.describe(
        'Number of blocks to wait before considering a transaction confirmed.',
      ),
      reorgPeriod: ZUint.optional().describe(
        'Number of blocks before a transaction has a near-zero chance of reverting.',
      ),
      estimateBlockTime: z
        .number()
        .positive()
        .finite()
        .optional()
        .describe('Rough estimate of time per block in seconds.'),
    })
    .optional()
    .describe('Block settings for the chain/deployment.'),
  transactionOverrides: z
    .record(z.any())
    .optional()
    .describe('Properties to include when forming transaction requests.'),
  gasCurrencyCoinGeckoId: z
    .string()
    .optional()
    .describe('The ID on CoinGecko of the token used for gas payments.'),
  gnosisSafeTransactionServiceUrl: z
    .string()
    .optional()
    .describe('The URL of the gnosis safe transaction service.'),
  bech32Prefix: z
    .string()
    .optional()
    .describe('The human readable address prefix for the chains using bech32.'),
  slip44: z.number().optional().describe('The SLIP-0044 coin type.'),
  isTestnet: z
    .boolean()
    .optional()
    .describe('Whether the chain is considered a testnet or a mainnet.'),
  index: z
    .object({
      from: z
        .number()
        .optional()
        .describe('The block to start any indexing from.'),
    })
    .optional()
    .describe('Indexing settings for the chain.'),
});

// Add refinements to the object schema to conditionally validate certain fields
export const ChainMetadataSchema = ChainMetadataSchemaObject.refine(
  (metadata) => {
    if (
      [ProtocolType.Ethereum, ProtocolType.Sealevel].includes(
        metadata.protocol,
      ) &&
      typeof metadata.chainId !== 'number'
    )
      return false;
    else if (
      metadata.protocol === ProtocolType.Cosmos &&
      typeof metadata.chainId !== 'string'
    )
      return false;
    else return true;
  },
  { message: 'Invalid Chain Id', path: ['chainId'] },
)
  .refine(
    (metadata) => {
      if (typeof metadata.chainId === 'string' && !metadata.domainId)
        return false;
      else return true;
    },
    { message: 'Domain Id required', path: ['domainId'] },
  )
  .refine(
    (metadata) => {
      if (
        metadata.protocol === ProtocolType.Cosmos &&
        (!metadata.bech32Prefix || !metadata.slip44)
      )
        return false;
      else return true;
    },
    {
      message: 'Bech32Prefix and Slip44 required for Cosmos chains',
      path: ['bech32Prefix', 'slip44'],
    },
  )
  .refine(
    (metadata) => {
      if (
        metadata.protocol === ProtocolType.Cosmos &&
        (!metadata.restUrls || !metadata.grpcUrls)
      )
        return false;
      else return true;
    },
    {
      message: 'Rest and gRPC URLs required for Cosmos chains',
      path: ['restUrls', 'grpcUrls'],
    },
  )
  .refine(
    (metadata) => {
      if (
        metadata.protocol === ProtocolType.Cosmos &&
        metadata.nativeToken &&
        !metadata.nativeToken.denom
      )
        return false;
      else return true;
    },
    {
      message: 'Denom values are required for Cosmos native tokens',
      path: ['nativeToken', 'denom'],
    },
  )
  .refine(
    (metadata) => {
      if (
        metadata.technicalStack === ChainTechnicalStack.ArbitrumNitro &&
        metadata.index?.from === undefined
      ) {
        return false;
      } else return true;
    },
    {
      message: 'An index.from value is required for Arbitrum Nitro chains',
      path: ['index', 'from'],
    },
  );

export type ChainMetadata<Ext = object> = z.infer<typeof ChainMetadataSchema> &
  Ext;

export type BlockExplorer = Exclude<
  ChainMetadata['blockExplorers'],
  undefined
>[number];

export function safeParseChainMetadata(
  c: ChainMetadata,
): SafeParseReturnType<ChainMetadata, ChainMetadata> {
  return ChainMetadataSchema.safeParse(c);
}

export function isValidChainMetadata(c: ChainMetadata): boolean {
  return ChainMetadataSchema.safeParse(c).success;
}

export function getDomainId(chainMetadata: ChainMetadata): number {
  if (chainMetadata.domainId) return chainMetadata.domainId;
  else if (typeof chainMetadata.chainId === 'number')
    return chainMetadata.chainId;
  else throw new Error('Invalid chain metadata, no valid domainId');
}

export function getChainIdNumber(chainMetadata: ChainMetadata): number {
  if (typeof chainMetadata.chainId === 'number') return chainMetadata.chainId;
  else throw new Error('ChainId is not a number, chain may be of Cosmos type');
}

export function getReorgPeriod(chainMetadata: ChainMetadata): number {
  if (chainMetadata.blocks?.reorgPeriod !== undefined)
    return chainMetadata.blocks.reorgPeriod;
  else throw new Error('Chain has no reorg period');
}
