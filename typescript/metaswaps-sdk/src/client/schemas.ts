import { z } from 'zod';

export const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

// Permissive token-address: accepts EVM hex, Solana base58, Cosmos bech32.
export const TokenAddress = z.string().min(1).max(100);
export const EngineAddress = z.string().min(1).max(100);
export const BigIntString = z.string().regex(/^\d+$/);
const MAX_UINT256 = 2n ** 256n - 1n;
const PositiveBigIntString = BigIntString.refine(
  (value) => {
    if (value.length > 78) return false;
    const amount = BigInt(value);
    return amount > 0n && amount <= MAX_UINT256;
  },
  { message: 'Expected positive uint256 integer' },
);
export const Hex = z.string().regex(/^0x[0-9a-fA-F]*$/);
export const Bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
// bytes20 (EVM) or bytes32 (padded EVM / non-EVM pubkey).
export const Recipient = z.string().min(1).max(100);

export const HealthResponseSchema = z.object({ ok: z.boolean() });
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ReadinessResponseSchema = z.object({
  ok: z.boolean(),
  graphReady: z.boolean(),
  graphConnections: z.number(),
  coreConfigChains: z.number(),
  chainCacheHydrated: z.boolean(),
  activeSnapshotUpdatedAt: z.string().nullable().optional(),
  activeSnapshotAgeMs: z.number().nullable().optional(),
  activeSnapshotExpiresAt: z.string().nullable().optional(),
  lastRouteCacheRefreshAt: z.string().nullable(),
  lastRouteCacheRefreshStatus: z.enum(['ok', 'error']).nullable(),
});
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;

export const NativeCurrencySchema = z.object({
  name: z.string(),
  symbol: z.string(),
  decimals: z.number(),
});

export const BlockExplorerSchema = z.object({
  name: z.string(),
  url: z.string(),
  family: z.string().optional(),
});
export type BlockExplorer = z.infer<typeof BlockExplorerSchema>;

export const ChainDiscoverySchema = z.object({
  id: z.number(),
  name: z.string(),
  chainName: z.string(),
  displayName: z.string().optional(),
  displayNameShort: z.string().optional(),
  protocol: z.string(),
  nativeCurrency: NativeCurrencySchema,
  universalRouter: Address,
  permit2: Address.optional(),
  dex: z.string().nullable(),
  canSwap: z.boolean(),
  canExecute: z.boolean(),
  supportsNative: z.boolean(),
  gasCurrencyCoinGeckoId: z.string().optional(),
  blockExplorers: z.array(BlockExplorerSchema).optional(),
});
export type ChainDiscovery = z.infer<typeof ChainDiscoverySchema>;

export const ChainsResponseSchema = z.object({
  chains: z.array(ChainDiscoverySchema),
});
export type ChainsResponse = z.infer<typeof ChainsResponseSchema>;

export const TokenDiscoverySchema = z.object({
  chainId: z.number(),
  address: TokenAddress,
  symbol: z.string(),
  name: z.string().optional(),
  decimals: z.number().nullable(),
  isNative: z.boolean(),
  wrappedAddress: TokenAddress.optional(),
  isBridgeToken: z.boolean(),
  isPoolToken: z.boolean(),
  isUserToken: z.boolean().optional(),
  canBridge: z.boolean(),
  canSwap: z.boolean(),
  balance: BigIntString.optional(),
  bridgeSymbols: z.array(z.string()),
  warpRouteIds: z.array(z.string()),
  standard: z.string().optional(),
  logoURI: z.string().optional(),
  coinGeckoId: z.string().optional(),
});
export type TokenDiscovery = z.infer<typeof TokenDiscoverySchema>;

// Engine returns two shapes for /v1/tokens:
//   ?chain=N      → { chain: ChainDiscovery, tokens: TokenDiscovery[] }
//   no params / ?ids / ?search → TokenDiscovery[]
// Normalize both into { chain?, tokens }.
export const TokensResponseSchema = z
  .union([
    z.object({
      chain: ChainDiscoverySchema.nullable().optional(),
      tokens: z.array(TokenDiscoverySchema),
    }),
    z.array(TokenDiscoverySchema),
  ])
  .transform((v) => (Array.isArray(v) ? { tokens: v } : v));
export type TokensResponse = z.infer<typeof TokensResponseSchema>;

export interface TokensQuery {
  chain?: number;
  search?: string;
  userAddress?: string;
  // Id format: `chainName-symbol` (e.g. "ethereum-USDC"). Max 5, mutually exclusive with chain/search.
  ids?: string[];
}

// ── Quote request ───────────────────────────────────────────────────────────

export const QuoteRequestSchema = z.object({
  srcChain: z.number(),
  dstChain: z.number(),
  srcToken: EngineAddress,
  dstToken: EngineAddress,
  amount: PositiveBigIntString,
  sender: EngineAddress,
  recipient: Recipient.optional(),
  slippageBps: z.number().int().min(0).max(10_000).optional(),
  commitmentSalt: Bytes32.optional(),
  usePermit2: z.boolean().optional(),
});
export type QuoteRequest = z.infer<typeof QuoteRequestSchema>;

// ── Quote response ──────────────────────────────────────────────────────────

export const QuoteSwapStepSchema = z.object({
  type: z.literal('swap'),
  chain: z.number(),
  dex: z.string(),
  tokenIn: EngineAddress,
  tokenOut: EngineAddress,
  amountIn: BigIntString,
  amountOut: BigIntString,
  path: z.array(EngineAddress),
  poolCount: z.number(),
  minPoolTvlUsd: z.number().nullable(),
  poolAddress: z.string().optional(),
});
export type QuoteSwapStep = z.infer<typeof QuoteSwapStepSchema>;

export const QuoteBridgeStepSchema = z.object({
  type: z.literal('bridge'),
  chain: z.number(),
  destChain: z.number(),
  asset: EngineAddress,
  router: EngineAddress,
  amountIn: BigIntString,
  amountOut: BigIntString,
  bridgeSymbol: z.string().optional(),
  warpRouteId: z.string().optional(),
  fee: z.object({
    tokenFee: BigIntString,
    igpToken: EngineAddress,
    igpAmount: BigIntString,
    localNativeFee: BigIntString,
  }),
});
export type QuoteBridgeStep = z.infer<typeof QuoteBridgeStepSchema>;

export const QuoteStepSchema = z.discriminatedUnion('type', [
  QuoteSwapStepSchema,
  QuoteBridgeStepSchema,
]);
export type QuoteStep = z.infer<typeof QuoteStepSchema>;

export const ChainRouteTxSchema = z.object({
  to: z.string(),
  data: z.string(),
  value: BigIntString,
  accounts: z
    .array(
      z.object({
        pubkey: z.string(),
        isSigner: z.boolean(),
        isWritable: z.boolean(),
      }),
    )
    .optional(),
  altAddresses: z.array(z.string()).optional(),
  preInstructions: z
    .array(
      z.object({
        programId: z.string(),
        accounts: z.array(
          z.object({
            pubkey: z.string(),
            isSigner: z.boolean(),
            isWritable: z.boolean(),
          }),
        ),
        data: z.string(),
      }),
    )
    .optional(),
});
export type ChainRouteTx = z.infer<typeof ChainRouteTxSchema>;

export const SdkRouteTxSchema = z.object({
  protocol: z.string().min(1),
  type: z.string().min(1),
  category: z.string().min(1),
  transaction: z.unknown(),
  metadata: z.record(z.unknown()).optional(),
});
export type SdkRouteTx = z.infer<typeof SdkRouteTxSchema>;

export const RouteTxSchema = z.union([ChainRouteTxSchema, SdkRouteTxSchema]);
export type RouteTx = z.infer<typeof RouteTxSchema>;

export const EvmRouteTxSchema = z.object({
  to: Address,
  data: Hex,
  value: BigIntString,
});
export type EvmRouteTx = z.infer<typeof EvmRouteTxSchema>;

export const RevealAccountSchema = z.object({
  pubkey: z.string().min(32).max(44),
  isWritable: z.boolean(),
  isSigner: z.boolean(),
});
export type RevealAccount = z.infer<typeof RevealAccountSchema>;

export const CallCommitmentBodySchema = z.object({
  commitment: Bytes32,
  originDomain: z.number(),
  data: Hex,
  salt: Bytes32,
  relayers: z.array(Bytes32),
  destinationAccount: Bytes32,
  revealAccounts: z.array(RevealAccountSchema).optional(),
});
export type CallCommitmentBody = z.infer<typeof CallCommitmentBodySchema>;

export const CallCommitmentSchema = z.object({
  version: z.literal(1),
  commitment: Bytes32,
  hash: z.object({
    algorithm: z.literal('keccak256'),
    preimage: z.string(),
    encodedCalls: Hex.optional(),
  }),
  ccs: z.object({
    method: z.literal('POST'),
    path: z.literal('/calldata'),
    body: CallCommitmentBodySchema,
  }),
});
export type CallCommitment = z.infer<typeof CallCommitmentSchema>;

export const RouteApprovalSchema = z.object({
  token: Address,
  spender: Address,
  amount: BigIntString,
  kind: z.enum(['erc20', 'permit2']),
  permit2Spender: Address.optional(),
});
export type RouteApproval = z.infer<typeof RouteApprovalSchema>;

export const RouteResponseSchema = z.object({
  steps: z.array(QuoteStepSchema),
  output: BigIntString,
  outputMin: BigIntString,
  executionKind: z.enum(['universalRouter', 'warpDirect', 'sdkWarp']),
  connection: z
    .object({ symbol: z.string(), warpRouteId: z.string() })
    .nullable(),
  gas: z.object({
    originGas: BigIntString,
    destGas: BigIntString,
  }),
  tx: RouteTxSchema.nullable(),
  txs: z.array(RouteTxSchema).optional(),
  approval: RouteApprovalSchema.nullable(),
  callCommitment: CallCommitmentSchema.optional(),
});
export type RouteResponse = z.infer<typeof RouteResponseSchema>;

export const QuoteRejectionSchema = z.object({
  code: z.string(),
  message: z.string(),
  srcChain: z.number(),
  dstChain: z.number(),
  srcToken: z.string(),
  dstToken: z.string(),
  amount: BigIntString,
  warpRouteId: z.string().optional(),
  bridgeSymbol: z.string().optional(),
  details: z
    .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
});
export type QuoteRejection = z.infer<typeof QuoteRejectionSchema>;

export const QuoteResponseSchema = z.object({
  routes: z.array(RouteResponseSchema),
  expiresAt: z.number(),
  rejections: z.array(QuoteRejectionSchema).optional(),
});
export type QuoteResponse = z.infer<typeof QuoteResponseSchema>;
