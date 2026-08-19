import { z } from 'zod';

import {
  AbstractCcipReadIsm,
  ArbL2ToL1Ism,
  CCIPIsm,
  DefaultIsm,
  DelayedFlowRouterHookIsm,
  IAggregationIsm,
  IInterchainSecurityModule,
  IMultisigIsm,
  IRoutingIsm,
  IStaticWeightedMultisigIsm,
  InterchainAccountRouter,
  NetFlowRateLimitedHookIsm,
  OPStackIsm,
  PausableIsm,
  RateLimitedIsm,
  TestIsm,
  TrustedRelayerIsm,
  BlacklistIsm,
} from '@hyperlane-xyz/core';
import type {
  Address,
  Domain,
  ValueOf,
  WithAddress,
} from '@hyperlane-xyz/utils';
import {
  addressToBytes32,
  isEmptyAddress,
  isNullish,
  isValidAddressSealevel,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  ZBigNumberish,
  ZBytes32String,
  ZHash,
} from '../metadata/customZodTypes.js';
import {
  ChainMap,
  OwnableConfig,
  OwnableSchema,
  PausableSchema,
  RATE_LIMIT_DEFAULT_DURATION_SECONDS,
} from '../types.js';
import { isCompliant } from '../utils/schemas.js';

// this enum should match the IInterchainSecurityModule.sol enum
// (COMPOSITE has no Solidity counterpart; it's Sealevel-only, matching
// rust/main/hyperlane-core's ModuleType)
// meant for the relayer
export enum ModuleType {
  UNUSED = 0,
  ROUTING = 1,
  AGGREGATION = 2,
  LEGACY_MULTISIG = 3, // DEPRECATED
  MERKLE_ROOT_MULTISIG = 4,
  MESSAGE_ID_MULTISIG = 5,
  NULL = 6,
  CCIP_READ = 7,
  ARB_L2_TO_L1 = 8,
  WEIGHTED_MERKLE_ROOT_MULTISIG = 9,
  WEIGHTED_MESSAGE_ID_MULTISIG = 10,
  OP_L2_TO_L1 = 11,
  POLYMER = 12,
  COMPOSITE = 13,
}

// this const object can be adjusted as per deployments necessary
// meant for the deployer and checker
export const IsmType = {
  CUSTOM: 'custom',
  OP_STACK: 'opStackIsm',
  ROUTING: 'domainRoutingIsm',
  INCREMENTAL_ROUTING: 'incrementalDomainRoutingIsm',
  FALLBACK_ROUTING: 'defaultFallbackRoutingIsm',
  AMOUNT_ROUTING: 'amountRoutingIsm',
  INTERCHAIN_ACCOUNT_ROUTING: 'interchainAccountRouting',
  AGGREGATION: 'staticAggregationIsm',
  STORAGE_AGGREGATION: 'storageAggregationIsm',
  MERKLE_ROOT_MULTISIG: 'merkleRootMultisigIsm',
  MESSAGE_ID_MULTISIG: 'messageIdMultisigIsm',
  STORAGE_MERKLE_ROOT_MULTISIG: 'storageMerkleRootMultisigIsm',
  STORAGE_MESSAGE_ID_MULTISIG: 'storageMessageIdMultisigIsm',
  TEST_ISM: 'testIsm',
  PAUSABLE: 'pausableIsm',
  TRUSTED_RELAYER: 'trustedRelayerIsm',
  ARB_L2_TO_L1: 'arbL2ToL1Ism',
  WEIGHTED_MERKLE_ROOT_MULTISIG: 'weightedMerkleRootMultisigIsm',
  WEIGHTED_MESSAGE_ID_MULTISIG: 'weightedMessageIdMultisigIsm',
  CCIP: 'ccipIsm',
  OFFCHAIN_LOOKUP: 'offchainLookupIsm',
  RATE_LIMITED: 'rateLimitedIsm',
  COMPOSITE: 'compositeIsm',
  BLACKLIST: 'blacklistIsm',
  // Ownerless routing ISM that always defers to the mailbox's default ISM.
  // Distinct from provider-sdk/AltVM's "default ISM" notion (the zero-address
  // mailbox field): this is a deployed contract with its own address.
  MAILBOX_DEFAULT: 'defaultIsm',
  // Hybrid hook/ISM: one contract instance is installed as BOTH the hook and
  // the ISM of a single warp router (shared bucket state). Deployed via the
  // ISM config surface; the hook side is referenced by address.
  NET_FLOW_RATE_LIMITED: 'netFlowRateLimitedHookIsm',
  DELAYED_FLOW_ROUTER: 'delayedFlowRouterHookIsm',
  UNKNOWN: 'unknownIsm',
} as const;

export type IsmType = (typeof IsmType)[keyof typeof IsmType];

export type DeployableIsmType = Exclude<
  IsmType,
  typeof IsmType.CUSTOM | typeof IsmType.UNKNOWN
>;

// ISM types that can be updated in-place on EVM chains (consumed by
// EvmIsmModule and its test fixtures). COMPOSITE is Sealevel-only and never
// appears as an EVM ISM config, so it's intentionally excluded here — its
// mutability is handled separately by SvmCompositeIsmWriter/deploy-sdk.
export const MUTABLE_ISM_TYPE: IsmType[] = [
  IsmType.ROUTING,
  IsmType.FALLBACK_ROUTING,
  IsmType.PAUSABLE,
  IsmType.OFFCHAIN_LOOKUP,
  IsmType.INCREMENTAL_ROUTING,
  IsmType.RATE_LIMITED,
  IsmType.BLACKLIST,
  // owner is the only mutable field; rate params force a redeploy
  IsmType.NET_FLOW_RATE_LIMITED,
  // owner + remote router enrollment are mutable; rate params force a redeploy
  IsmType.DELAYED_FLOW_ROUTER,
];

/**
 * @notice Statically deployed ISM types
 * @dev ISM types with immutable config embedded in contract bytecode via MetaProxy
 */
export const STATIC_ISM_TYPES: IsmType[] = [
  IsmType.AGGREGATION,
  IsmType.MERKLE_ROOT_MULTISIG,
  IsmType.MESSAGE_ID_MULTISIG,
  IsmType.WEIGHTED_MERKLE_ROOT_MULTISIG,
  IsmType.WEIGHTED_MESSAGE_ID_MULTISIG,
];

export const DYNAMICALLY_ROUTED_ISM_TYPES = [
  IsmType.AMOUNT_ROUTING,
  IsmType.INTERCHAIN_ACCOUNT_ROUTING,
  // No static domains table: route() resolves to the mailbox's default ISM
  IsmType.MAILBOX_DEFAULT,
] as const;

/** Type guard for dynamically routed ISM types */
export function isDynamicallyRoutedIsmType(
  type: IsmType,
): type is (typeof DYNAMICALLY_ROUTED_ISM_TYPES)[number] {
  return (DYNAMICALLY_ROUTED_ISM_TYPES as readonly IsmType[]).includes(type);
}

// mapping between the two enums
export function ismTypeToModuleType(ismType: IsmType): ModuleType {
  switch (ismType) {
    case IsmType.ROUTING:
    case IsmType.FALLBACK_ROUTING:
    case IsmType.AMOUNT_ROUTING:
    case IsmType.INTERCHAIN_ACCOUNT_ROUTING:
    case IsmType.INCREMENTAL_ROUTING:
    case IsmType.MAILBOX_DEFAULT:
      return ModuleType.ROUTING;
    case IsmType.AGGREGATION:
    case IsmType.STORAGE_AGGREGATION:
      return ModuleType.AGGREGATION;
    case IsmType.MERKLE_ROOT_MULTISIG:
    case IsmType.STORAGE_MERKLE_ROOT_MULTISIG:
      return ModuleType.MERKLE_ROOT_MULTISIG;
    case IsmType.MESSAGE_ID_MULTISIG:
    case IsmType.STORAGE_MESSAGE_ID_MULTISIG:
      return ModuleType.MESSAGE_ID_MULTISIG;
    case IsmType.OP_STACK:
    case IsmType.TEST_ISM:
    case IsmType.PAUSABLE:
    case IsmType.CUSTOM:
    case IsmType.TRUSTED_RELAYER:
    case IsmType.CCIP:
    case IsmType.RATE_LIMITED:
    case IsmType.BLACKLIST:
    case IsmType.NET_FLOW_RATE_LIMITED:
    case IsmType.DELAYED_FLOW_ROUTER:
      return ModuleType.NULL;
    case IsmType.ARB_L2_TO_L1:
      return ModuleType.ARB_L2_TO_L1;
    case IsmType.WEIGHTED_MERKLE_ROOT_MULTISIG:
      return ModuleType.WEIGHTED_MERKLE_ROOT_MULTISIG;
    case IsmType.WEIGHTED_MESSAGE_ID_MULTISIG:
      return ModuleType.WEIGHTED_MESSAGE_ID_MULTISIG;
    case IsmType.OFFCHAIN_LOOKUP:
      return ModuleType.CCIP_READ;
    case IsmType.COMPOSITE:
      return ModuleType.COMPOSITE;
    case IsmType.UNKNOWN:
      return ModuleType.UNUSED;
  }
}

export type ValidatorConfig = {
  address: Address;
  alias: string;
};

export type MultisigConfig = {
  validators: Array<ValidatorConfig>;
  threshold: number;
};

export type MultisigIsmConfig = z.infer<typeof MultisigIsmConfigSchema>;
export type WeightedMultisigIsmConfig = z.infer<
  typeof WeightedMultisigIsmConfigSchema
>;
export type TestIsmConfig = z.infer<typeof TestIsmConfigSchema>;
export type PausableIsmConfig = z.infer<typeof PausableIsmConfigSchema>;
export type OpStackIsmConfig = z.infer<typeof OpStackIsmConfigSchema>;
export type TrustedRelayerIsmConfig = z.infer<
  typeof TrustedRelayerIsmConfigSchema
>;
export type CCIPIsmConfig = z.infer<typeof CCIPIsmConfigSchema>;
export type ArbL2ToL1IsmConfig = z.infer<typeof ArbL2ToL1IsmConfigSchema>;
export type RateLimitedIsmConfig = z.infer<typeof RateLimitedIsmConfigSchema>;
export type BlacklistIsmConfig = z.infer<typeof BlacklistIsmConfigSchema>;

export type OffchainLookupIsmConfig = z.infer<
  typeof OffchainLookupIsmConfigSchema
>;
export type MailboxDefaultIsmConfig = z.infer<
  typeof MailboxDefaultIsmConfigSchema
>;
export type NetFlowRateLimitedHookIsmConfig = z.infer<
  typeof NetFlowRateLimitedHookIsmConfigSchema
>;
export type DelayedFlowRouterHookIsmConfig = z.infer<
  typeof DelayedFlowRouterHookIsmConfigSchema
>;

export type NullIsmConfig =
  | TestIsmConfig
  | PausableIsmConfig
  | OpStackIsmConfig
  | TrustedRelayerIsmConfig
  | CCIPIsmConfig
  | RateLimitedIsmConfig
  | BlacklistIsmConfig
  | NetFlowRateLimitedHookIsmConfig
  | DelayedFlowRouterHookIsmConfig;

type BaseRoutingIsmConfig<
  T extends
    | typeof IsmType.ROUTING
    | typeof IsmType.FALLBACK_ROUTING
    | typeof IsmType.AMOUNT_ROUTING
    | typeof IsmType.INTERCHAIN_ACCOUNT_ROUTING
    | typeof IsmType.INCREMENTAL_ROUTING,
> = {
  type: T;
};

export type DomainRoutingIsmConfig = BaseRoutingIsmConfig<
  | typeof IsmType.ROUTING
  | typeof IsmType.FALLBACK_ROUTING
  | typeof IsmType.INCREMENTAL_ROUTING
> &
  OwnableConfig & { domains: ChainMap<IsmConfig> };

export const InterchainAccountRouterIsmSchema = OwnableSchema.extend({
  type: z.literal(IsmType.INTERCHAIN_ACCOUNT_ROUTING),
  isms: z.record(ZHash),
});
export type InterchainAccountRouterIsm = z.infer<
  typeof InterchainAccountRouterIsmSchema
>;

export type AmountRoutingIsmConfig = BaseRoutingIsmConfig<
  typeof IsmType.AMOUNT_ROUTING
> & {
  lowerIsm: IsmConfig;
  upperIsm: IsmConfig;
  threshold: number;
};

export type RoutingIsmConfig =
  | DomainRoutingIsmConfig
  | AmountRoutingIsmConfig
  | InterchainAccountRouterIsm;

export type AggregationIsmConfig = {
  type: typeof IsmType.AGGREGATION | typeof IsmType.STORAGE_AGGREGATION;
  modules: Array<IsmConfig>;
  threshold: number;
};

// Explicit (not z.infer) union: IsmConfigSchema gets annotated with this type
// below so downstream `.extend()`/`.merge()` chains (MailboxClientConfigSchema
// and everything built on it) reference this pre-computed type instead of
// re-expanding the full union's structure on every merge, which otherwise
// risks TS2590 ("union too complex to represent") once the union is large
// enough — confirmed via a control-group test that any new member (not just
// compositeIsm) trips this ceiling.
export type IsmConfig =
  | Address
  | TestIsmConfig
  | OpStackIsmConfig
  | DerivedPausableIsmConfig
  | PausableIsmConfig
  | TrustedRelayerIsmConfig
  | CCIPIsmConfig
  | RateLimitedIsmConfig
  | BlacklistIsmConfig
  | NetFlowRateLimitedHookIsmConfig
  | DelayedFlowRouterHookIsmConfig
  | MailboxDefaultIsmConfig
  | MultisigIsmConfig
  | WeightedMultisigIsmConfig
  | RoutingIsmConfig
  | AggregationIsmConfig
  | CompositeIsmConfig
  | ArbL2ToL1IsmConfig
  | OffchainLookupIsmConfig
  | InterchainAccountRouterIsm
  | UnknownIsmConfig;

export type DerivedIsmConfig = WithAddress<Exclude<IsmConfig, Address>>;

export type DeployedIsmType = {
  [IsmType.CUSTOM]: IInterchainSecurityModule;
  [IsmType.ROUTING]: IRoutingIsm;
  [IsmType.FALLBACK_ROUTING]: IRoutingIsm;
  [IsmType.AMOUNT_ROUTING]: IRoutingIsm;
  [IsmType.INCREMENTAL_ROUTING]: IRoutingIsm;
  [IsmType.AGGREGATION]: IAggregationIsm;
  [IsmType.STORAGE_AGGREGATION]: IAggregationIsm;
  [IsmType.MERKLE_ROOT_MULTISIG]: IMultisigIsm;
  [IsmType.MESSAGE_ID_MULTISIG]: IMultisigIsm;
  [IsmType.STORAGE_MERKLE_ROOT_MULTISIG]: IMultisigIsm;
  [IsmType.STORAGE_MESSAGE_ID_MULTISIG]: IMultisigIsm;
  [IsmType.OP_STACK]: OPStackIsm;
  [IsmType.TEST_ISM]: TestIsm;
  [IsmType.PAUSABLE]: PausableIsm;
  [IsmType.TRUSTED_RELAYER]: TrustedRelayerIsm;
  [IsmType.CCIP]: CCIPIsm;
  [IsmType.ARB_L2_TO_L1]: ArbL2ToL1Ism;
  [IsmType.WEIGHTED_MERKLE_ROOT_MULTISIG]: IStaticWeightedMultisigIsm;
  [IsmType.WEIGHTED_MESSAGE_ID_MULTISIG]: IStaticWeightedMultisigIsm;
  [IsmType.OFFCHAIN_LOOKUP]: AbstractCcipReadIsm;
  [IsmType.INTERCHAIN_ACCOUNT_ROUTING]: InterchainAccountRouter;
  [IsmType.RATE_LIMITED]: RateLimitedIsm;
  [IsmType.BLACKLIST]: BlacklistIsm;
  [IsmType.MAILBOX_DEFAULT]: DefaultIsm;
  [IsmType.NET_FLOW_RATE_LIMITED]: NetFlowRateLimitedHookIsm;
  [IsmType.DELAYED_FLOW_ROUTER]: DelayedFlowRouterHookIsm;
  [IsmType.UNKNOWN]: IInterchainSecurityModule;
};

export type DeployedIsm = ValueOf<DeployedIsmType>;

// for finding the difference between the onchain deployment and the config provided
export type RoutingIsmDelta = {
  domainsToUnenroll: Domain[]; // new or updated isms for the domain
  domainsToEnroll: Domain[]; // isms to remove
  owner?: Address; // is the owner different
  mailbox?: Address; // is the mailbox different (only for fallback routing)
};

const ValidatorInfoSchema = z.object({
  signingAddress: ZHash,
  weight: z.number(),
});

export const TestIsmConfigSchema = z.object({
  type: z.literal(IsmType.TEST_ISM),
});

export const MultisigConfigSchema = z.object({
  validators: z.array(ZHash),
  threshold: z.number(),
});

export const WeightedMultisigConfigSchema = z.object({
  validators: z.array(ValidatorInfoSchema),
  thresholdWeight: z.number(),
});

export const TrustedRelayerIsmConfigSchema = z.object({
  type: z.literal(IsmType.TRUSTED_RELAYER),
  relayer: z.string(),
});

export const BlacklistIsmConfigSchema = OwnableSchema.extend({
  type: z.literal(IsmType.BLACKLIST),
  blacklistedIds: z.array(ZBytes32String),
});

export const RateLimitedIsmConfigSchema = z
  .object({
    type: z.literal(IsmType.RATE_LIMITED),
    maxCapacity: z
      .string()
      .regex(/^\d+$/, 'maxCapacity must be a base-10 integer string'),
    /**
     * Refill window in seconds — must match the on-chain immutable
     * `DURATION`. Defaults to 1 day (86400s) when omitted, matching the
     * previous hard-coded on-chain window.
     */
    duration: ZBigNumberish.default(RATE_LIMIT_DEFAULT_DURATION_SECONDS),
    recipient: ZHash.optional(),
    owner: ZHash.optional(),
  })
  .refine((val) => val.duration > 0n, {
    message: 'duration must be greater than 0',
    path: ['duration'],
  })
  .refine((val) => BigInt(val.maxCapacity) >= val.duration, {
    message: 'maxCapacity must be at least duration',
    path: ['maxCapacity'],
  })
  .transform((val) => {
    const capacity = BigInt(val.maxCapacity);
    const duration = val.duration;
    if (capacity % duration !== 0n) {
      const rounded = ((capacity / duration) * duration).toString();
      rootLogger.warn(
        `RateLimitedIsm maxCapacity ${val.maxCapacity} is not divisible by duration ${val.duration}; rounding down to ${rounded}`,
      );
      return { ...val, maxCapacity: rounded };
    }
    return val;
  });

export const MailboxDefaultIsmConfigSchema = z.object({
  type: z.literal(IsmType.MAILBOX_DEFAULT),
  // No config fields: the mailbox is chain identity, supplied by the deploy
  // context (like TRUSTED_RELAYER / RATE_LIMITED), not the declarative config.
});

/**
 * Remote counterpart of a DelayedFlowRouterHookIsm, enrolled as a Router
 * route. Accepts a 20-byte EVM address or a 32-byte hex value; normalized to
 * lowercase bytes32 (the on-chain `routers(uint32)` representation) at parse
 * time so config and derived on-chain state compare equal. Shared with the
 * hook-side view of the same contract (../hook/types.ts).
 */
export const ZRouterBytes32 = z
  .string()
  .regex(
    /^0x([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/,
    'must be a 20-byte address or 32-byte hex value',
  )
  .refine((value) => !isEmptyAddress(value), {
    message: 'must not be the zero address',
  })
  .transform((value) => addressToBytes32(value).toLowerCase());

export const NetFlowRateLimitedHookIsmConfigSchema = z
  .object({
    type: z.literal(IsmType.NET_FLOW_RATE_LIMITED),
    /**
     * Warp router this contract guards; must have it installed as hook AND
     * ISM. Optional in warp-route deploy configs (defaults to the containing
     * warp router, injected at deploy time like RATE_LIMITED's recipient);
     * required for standalone ISM deploys (asserted in HyperlaneIsmFactory).
     */
    warpRouter: ZHash.optional(),
    /** Net outflow allowed per `duration` window, in bps of live TVL (< 10000). */
    thresholdBps: z.number().int().min(0).max(9999),
    /** Refill window in seconds — must match the on-chain immutable `DURATION`. */
    duration: ZBigNumberish,
    owner: ZHash.optional(),
  })
  .refine((val) => val.duration > 0n, {
    message: 'duration must be greater than 0',
    path: ['duration'],
  });

export const DelayedFlowRouterHookIsmConfigSchema = OwnableSchema.extend({
  type: z.literal(IsmType.DELAYED_FLOW_ROUTER),
  /**
   * Warp router this contract guards; must have it installed as hook AND
   * ISM. Optional in warp-route deploy configs (defaults to the containing
   * warp router, injected at deploy time like RATE_LIMITED's recipient);
   * required for standalone ISM deploys (asserted in HyperlaneIsmFactory).
   */
  warpRouter: ZHash.optional(),
  /** Bucket size per `duration` window, in bps of live TVL (delay mode permits 100%). */
  thresholdBps: z.number().int().min(0).max(10000),
  /** Cap on any single message's wait time, in seconds (uint48). */
  /** Cap on any single message's wait, in seconds. uint48 on-chain. */
  maxDelay: z.number().int().nonnegative().max(281474976710655),
  /** Refill window in seconds — must match the on-chain immutable `DURATION`. */
  duration: ZBigNumberish,
  /**
   * Enrolled remote counterparts, keyed by chain name; values are the remote
   * DelayedFlowRouterHookIsm instances (the contract is itself a Router, so
   * on-chain nomenclature keeps "router": enrollRemoteRouters/routers()).
   * Omit to leave the current on-chain enrollment untouched.
   */
  remoteIsms: z.record(ZRouterBytes32).optional(),
}).refine((val) => val.duration > 0n, {
  message: 'duration must be greater than 0',
  path: ['duration'],
});

export const CCIPIsmConfigSchema = z.object({
  type: z.literal(IsmType.CCIP),
  originChain: z.string(),
});

export const OffchainLookupIsmConfigSchema = OwnableSchema.extend({
  type: z.literal(IsmType.OFFCHAIN_LOOKUP),
  urls: z.array(z.string().url()),
});

export const isOffchainLookupIsmConfig = isCompliant(
  OffchainLookupIsmConfigSchema,
);

export const OpStackIsmConfigSchema = z.object({
  type: z.literal(IsmType.OP_STACK),
  origin: z.string(),
  nativeBridge: z.string(),
});

export const ArbL2ToL1IsmConfigSchema = z.object({
  type: z.literal(IsmType.ARB_L2_TO_L1),
  bridge: z.string(),
});

export const PausableIsmConfigSchema = PausableSchema.and(
  z.object({
    type: z.literal(IsmType.PAUSABLE),
  }),
);
export const DerivedPausableIsmConfigSchema = PausableIsmConfigSchema.and(
  z.object({
    address: ZHash,
  }),
);
export type DerivedPausableIsmConfig = z.infer<
  typeof DerivedPausableIsmConfigSchema
>;

export const MultisigIsmConfigSchema = MultisigConfigSchema.and(
  z.object({
    type: z.union([
      z.literal(IsmType.MERKLE_ROOT_MULTISIG),
      z.literal(IsmType.MESSAGE_ID_MULTISIG),
      z.literal(IsmType.STORAGE_MERKLE_ROOT_MULTISIG),
      z.literal(IsmType.STORAGE_MESSAGE_ID_MULTISIG),
    ]),
  }),
);

export const WeightedMultisigIsmConfigSchema = WeightedMultisigConfigSchema.and(
  z.object({
    type: z.union([
      z.literal(IsmType.WEIGHTED_MERKLE_ROOT_MULTISIG),
      z.literal(IsmType.WEIGHTED_MESSAGE_ID_MULTISIG),
    ]),
  }),
);

export const RoutingIsmConfigSchema: z.ZodType<
  RoutingIsmConfig,
  z.ZodTypeDef,
  unknown
> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal(IsmType.AMOUNT_ROUTING),
      lowerIsm: BaseIsmConfigSchema,
      upperIsm: BaseIsmConfigSchema,
      threshold: z.number(),
    }),
    OwnableSchema.extend({
      type: z.enum([
        IsmType.ROUTING,
        IsmType.FALLBACK_ROUTING,
        IsmType.INCREMENTAL_ROUTING,
      ]),
      domains: z.record(BaseIsmConfigSchema),
    }),
    InterchainAccountRouterIsmSchema,
  ]),
);

export const AggregationIsmConfigSchema: z.ZodType<
  AggregationIsmConfig,
  z.ZodTypeDef,
  unknown
> = z
  .lazy(() =>
    z.object({
      type: z.union([
        z.literal(IsmType.AGGREGATION),
        z.literal(IsmType.STORAGE_AGGREGATION),
      ]),
      modules: z.array(BaseIsmConfigSchema),
      threshold: z.number(),
    }),
  )
  .refine((data) => data.threshold <= data.modules.length, {
    message: 'Threshold must be less than or equal to the number of modules',
  });

// Composite ISM (Sealevel-only) wire-format-specific schemas. Unlike ZHash
// (deliberately multi-format, for config fields that may hold an address
// from any protocol), these fields always have one specific wire format —
// using ZHash for them would let an EVM hex string pass as a Sealevel
// pubkey, a base58 pubkey pass as an H160 validator, or a 20-byte hash pass
// as the required 32-byte H256 recipient, only failing later in the writer's
// parseAddress/encodeH160/encodeH256 calls, after resolveProgram() has
// already deployed the program on-chain.
const ZSealevelPubkey = z
  .string()
  .refine((value) => isValidAddressSealevel(value), {
    message: 'must be a valid base58-encoded Sealevel address',
  });
const ZH160Hex = z
  .string()
  .regex(
    /^0x[0-9a-fA-F]{40}$/,
    'must be a 20-byte (0x + 40 hex chars) address',
  );
const ZH256Hex = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte (0x + 64 hex chars) hash');

const U64_MAX = 2n ** 64n - 1n;
const U256_MAX = 2n ** 256n - 1n;

// MultisigMessageId.threshold and Aggregation.threshold are Borsh-encoded
// as u8 on-chain — a value outside 0-255 parses fine as a JS number but
// throws in getU8Codec().encode() after the program has already deployed.
const ZU8Threshold = z.number().int().min(0).max(255);

/** Base-10 integer string bounded to fit the given Borsh-encoded wire width. */
function decimalStringBoundedBy(max: bigint, label: string) {
  return z
    .string()
    .regex(/^\d+$/, `${label} must be a base-10 integer string`)
    .refine(
      // Zod runs every check in the chain regardless of earlier failures
      // (no short-circuiting), so BigInt(value) must stay guarded here even
      // though the regex above already rejects non-digit strings —
      // otherwise a value like "abc" throws inside refine and crashes
      // safeParse() instead of returning { success: false }.
      (value) => /^\d+$/.test(value) && BigInt(value) <= max,
      { message: `${label} exceeds the maximum value representable on-chain` },
    );
}

// Discriminants for nodes inside a compositeIsm tree (Sealevel-only).
// Distinct namespace from IsmType: these tag inline Borsh nodes within a
// single composite-ism PDA, not separately deployed/addressed ISMs.
export const CompositeIsmNodeType = {
  TRUSTED_RELAYER: 'trustedRelayer',
  MULTISIG_MESSAGE_ID: 'multisigMessageId',
  AGGREGATION: 'aggregation',
  TEST: 'test',
  PAUSABLE: 'pausable',
  AMOUNT_ROUTING: 'amountRouting',
  RATE_LIMITED: 'rateLimited',
  ROUTING: 'routing',
  FALLBACK_ROUTING: 'fallbackRouting',
} as const;
export type CompositeIsmNodeType =
  (typeof CompositeIsmNodeType)[keyof typeof CompositeIsmNodeType];

export interface CompositeTrustedRelayerNodeConfig {
  type: typeof CompositeIsmNodeType.TRUSTED_RELAYER;
  relayer: Address;
}
export interface CompositeMultisigMessageIdNodeConfig {
  type: typeof CompositeIsmNodeType.MULTISIG_MESSAGE_ID;
  validators: Address[];
  threshold: number;
}
export interface CompositeAggregationNodeConfig {
  type: typeof CompositeIsmNodeType.AGGREGATION;
  threshold: number;
  subIsms: CompositeIsmNodeConfig[];
}
export interface CompositeTestNodeConfig {
  type: typeof CompositeIsmNodeType.TEST;
  accept: boolean;
}
export interface CompositePausableNodeConfig {
  type: typeof CompositeIsmNodeType.PAUSABLE;
  paused: boolean;
}
export interface CompositeAmountRoutingNodeConfig {
  type: typeof CompositeIsmNodeType.AMOUNT_ROUTING;
  threshold: string;
  lower: CompositeIsmNodeConfig;
  upper: CompositeIsmNodeConfig;
}
export interface CompositeRateLimitedNodeConfig {
  type: typeof CompositeIsmNodeType.RATE_LIMITED;
  maxCapacity: string;
  mailbox: Address;
  recipient?: Address;
}
export interface CompositeRoutingNodeConfig {
  type: typeof CompositeIsmNodeType.ROUTING;
  domains?: ChainMap<CompositeIsmNodeConfig>;
}
export interface CompositeFallbackRoutingNodeConfig {
  type: typeof CompositeIsmNodeType.FALLBACK_ROUTING;
  fallbackIsm: Address;
  domains?: ChainMap<CompositeIsmNodeConfig>;
}

export type CompositeIsmNodeConfig =
  | CompositeTrustedRelayerNodeConfig
  | CompositeMultisigMessageIdNodeConfig
  | CompositeAggregationNodeConfig
  | CompositeTestNodeConfig
  | CompositePausableNodeConfig
  | CompositeAmountRoutingNodeConfig
  | CompositeRateLimitedNodeConfig
  | CompositeRoutingNodeConfig
  | CompositeFallbackRoutingNodeConfig;

export const CompositeIsmNodeConfigSchema: z.ZodSchema<CompositeIsmNodeConfig> =
  z.lazy(() =>
    z.discriminatedUnion('type', [
      z.object({
        type: z.literal(CompositeIsmNodeType.TRUSTED_RELAYER),
        relayer: ZSealevelPubkey,
      }),
      z.object({
        type: z.literal(CompositeIsmNodeType.MULTISIG_MESSAGE_ID),
        validators: z.array(ZH160Hex),
        threshold: ZU8Threshold,
      }),
      z.object({
        type: z.literal(CompositeIsmNodeType.AGGREGATION),
        threshold: ZU8Threshold,
        subIsms: z.array(CompositeIsmNodeConfigSchema),
      }),
      z.object({
        type: z.literal(CompositeIsmNodeType.TEST),
        accept: z.boolean(),
      }),
      z.object({
        type: z.literal(CompositeIsmNodeType.PAUSABLE),
        paused: z.boolean(),
      }),
      z.object({
        type: z.literal(CompositeIsmNodeType.AMOUNT_ROUTING),
        threshold: decimalStringBoundedBy(U256_MAX, 'threshold'),
        lower: CompositeIsmNodeConfigSchema,
        upper: CompositeIsmNodeConfigSchema,
      }),
      z.object({
        type: z.literal(CompositeIsmNodeType.RATE_LIMITED),
        maxCapacity: decimalStringBoundedBy(U64_MAX, 'maxCapacity'),
        mailbox: ZSealevelPubkey,
        recipient: ZH256Hex.optional(),
      }),
      z.object({
        type: z.literal(CompositeIsmNodeType.ROUTING),
        domains: z.record(CompositeIsmNodeConfigSchema).optional(),
      }),
      z.object({
        type: z.literal(CompositeIsmNodeType.FALLBACK_ROUTING),
        fallbackIsm: ZSealevelPubkey,
        domains: z.record(CompositeIsmNodeConfigSchema).optional(),
      }),
    ]),
  );

export type CompositeIsmConfig = OwnableConfig & {
  type: typeof IsmType.COMPOSITE;
  root: CompositeIsmNodeConfig;
};

/** True if a `fallbackRouting` node exists anywhere in this subtree. */
function containsFallbackRouting(node: CompositeIsmNodeConfig): boolean {
  switch (node.type) {
    case CompositeIsmNodeType.FALLBACK_ROUTING:
      return true;
    case CompositeIsmNodeType.AGGREGATION:
      return node.subIsms.some(containsFallbackRouting);
    case CompositeIsmNodeType.AMOUNT_ROUTING:
      return (
        containsFallbackRouting(node.lower) ||
        containsFallbackRouting(node.upper)
      );
    default:
      return false;
  }
}

type CompositeIsmValidationState = { routingFound: boolean };

/**
 * Recursively mirrors the Rust program's `validate_config`/
 * `validate_domain_ism` semantic checks
 * (rust/sealevel/programs/ism/composite-ism/src/processor.rs) so an invalid
 * config is caught at parse time instead of after the writer has already
 * deployed/initialized the program on-chain.
 */
function validateCompositeIsmTree(
  node: CompositeIsmNodeConfig,
  path: (string | number)[],
  state: CompositeIsmValidationState,
  insideDomainIsm: boolean,
  ctx: z.RefinementCtx,
): void {
  const addIssue = (message: string, subPath: (string | number)[] = path) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: subPath });

  switch (node.type) {
    case CompositeIsmNodeType.AGGREGATION:
      if (node.threshold < 1 || node.threshold > node.subIsms.length) {
        addIssue(
          'Threshold must be between 1 and the number of subIsms (inclusive)',
          [...path, 'threshold'],
        );
      }
      // FallbackRouting must be the last sub-ISM (checked transitively) —
      // verify_node drains the accounts iterator entirely on the fallback
      // path, so any sibling after it would fail with NotEnoughAccountKeys.
      node.subIsms.slice(0, -1).forEach((sub, i) => {
        if (containsFallbackRouting(sub)) {
          addIssue('fallbackRouting must be the last entry in subIsms', [
            ...path,
            'subIsms',
            i,
          ]);
        }
      });
      node.subIsms.forEach((sub, i) =>
        validateCompositeIsmTree(
          sub,
          [...path, 'subIsms', i],
          state,
          insideDomainIsm,
          ctx,
        ),
      );
      break;
    case CompositeIsmNodeType.MULTISIG_MESSAGE_ID: {
      if (node.threshold < 1 || node.threshold > node.validators.length) {
        addIssue(
          'Threshold must be between 1 and the number of validators (inclusive)',
          [...path, 'threshold'],
        );
      }
      const seen = new Set<string>();
      for (const validator of node.validators) {
        const normalized = validator.toLowerCase();
        if (seen.has(normalized)) {
          addIssue(`Duplicate validator address: ${validator}`, [
            ...path,
            'validators',
          ]);
          break;
        }
        seen.add(normalized);
      }
      break;
    }
    case CompositeIsmNodeType.RATE_LIMITED:
      // Guarded: superRefine runs regardless of whether maxCapacity's own
      // field-level schema (decimalStringBoundedBy) already rejected it —
      // BigInt() on a malformed string would otherwise throw here too and
      // crash safeParse() instead of returning { success: false }.
      if (/^\d+$/.test(node.maxCapacity) && BigInt(node.maxCapacity) === 0n) {
        addIssue('maxCapacity must be non-zero', [...path, 'maxCapacity']);
      }
      if (isEmptyAddress(node.mailbox)) {
        addIssue('mailbox must be a non-zero address', [...path, 'mailbox']);
      }
      if (!node.recipient || isEmptyAddress(node.recipient)) {
        addIssue('recipient is required and must be a non-zero address', [
          ...path,
          'recipient',
        ]);
      }
      break;
    case CompositeIsmNodeType.TRUSTED_RELAYER:
      if (isEmptyAddress(node.relayer)) {
        addIssue('relayer must be a non-zero address', [...path, 'relayer']);
      }
      break;
    case CompositeIsmNodeType.AMOUNT_ROUTING:
      validateCompositeIsmTree(
        node.lower,
        [...path, 'lower'],
        state,
        insideDomainIsm,
        ctx,
      );
      validateCompositeIsmTree(
        node.upper,
        [...path, 'upper'],
        state,
        insideDomainIsm,
        ctx,
      );
      break;
    case CompositeIsmNodeType.PAUSABLE:
      if (insideDomainIsm) {
        addIssue('pausable is not allowed inside a domain override');
      }
      break;
    case CompositeIsmNodeType.ROUTING:
    case CompositeIsmNodeType.FALLBACK_ROUTING:
      if (insideDomainIsm) {
        addIssue(`${node.type} is not allowed inside a domain override`);
        break;
      }
      if (
        node.type === CompositeIsmNodeType.FALLBACK_ROUTING &&
        isEmptyAddress(node.fallbackIsm)
      ) {
        addIssue('fallbackIsm must be a non-zero address', [
          ...path,
          'fallbackIsm',
        ]);
      }
      if (state.routingFound) {
        addIssue('Only one routing/fallbackRouting node is allowed per tree');
      }
      state.routingFound = true;
      for (const [chain, domainNode] of Object.entries(node.domains ?? {})) {
        validateCompositeIsmTree(
          domainNode,
          [...path, 'domains', chain],
          state,
          true,
          ctx,
        );
      }
      break;
    case CompositeIsmNodeType.TEST:
      break;
  }
}

export const CompositeIsmConfigSchema: z.ZodSchema<CompositeIsmConfig> =
  OwnableSchema.extend({
    type: z.literal(IsmType.COMPOSITE),
    // Composite ISM is Sealevel-only, so unlike OwnableSchema's generic
    // multi-format owner (shared across every ISM/hook/token config type),
    // owner here is always a Sealevel pubkey.
    owner: ZSealevelPubkey,
    root: CompositeIsmNodeConfigSchema,
  }).superRefine((data, ctx) => {
    validateCompositeIsmTree(
      data.root,
      ['root'],
      { routingFound: false },
      false,
      ctx,
    );
  });

export const UnknownIsmConfigSchema = z
  .object({
    type: z.literal(IsmType.UNKNOWN),
  })
  .passthrough();
export type UnknownIsmConfig = z.infer<typeof UnknownIsmConfigSchema>;

const KnownIsmTypes: string[] = Object.values(IsmType).filter(
  (t) => t !== IsmType.UNKNOWN,
);

/**
 * Recursively normalizes unknown ISM type values to IsmType.UNKNOWN.
 * Use this before parsing with IsmConfigSchema when configs may contain
 * ISM types not yet known to this SDK version.
 *
 * Note: String address configs (e.g., "0x...") are passed through unchanged
 * since they represent deployed ISM addresses, not ISM type configs.
 */
export function normalizeUnknownIsmTypes<T>(config: T): T {
  // Handle nullish values and primitives (including string addresses)
  if (isNullish(config) || typeof config !== 'object') {
    return config;
  }

  if (Array.isArray(config)) {
    return config.map(normalizeUnknownIsmTypes) as T;
  }

  // At this point, config must be a non-null object (not array, not primitive)
  const obj = config as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (key === 'type' && typeof value === 'string') {
      normalized[key] = KnownIsmTypes.includes(value) ? value : IsmType.UNKNOWN;
    } else if (typeof value === 'object' && !isNullish(value)) {
      normalized[key] = normalizeUnknownIsmTypes(value);
    } else {
      normalized[key] = value;
    }
  }

  return normalized as T;
}

export const BaseIsmConfigSchema: z.ZodType<IsmConfig, z.ZodTypeDef, unknown> =
  z.union([
    ZHash,
    TestIsmConfigSchema,
    OpStackIsmConfigSchema,
    DerivedPausableIsmConfigSchema,
    PausableIsmConfigSchema,
    TrustedRelayerIsmConfigSchema,
    CCIPIsmConfigSchema,
    RateLimitedIsmConfigSchema,
    BlacklistIsmConfigSchema,
    NetFlowRateLimitedHookIsmConfigSchema,
    DelayedFlowRouterHookIsmConfigSchema,
    MailboxDefaultIsmConfigSchema,
    MultisigIsmConfigSchema,
    WeightedMultisigIsmConfigSchema,
    RoutingIsmConfigSchema,
    AggregationIsmConfigSchema,
    CompositeIsmConfigSchema,
    ArbL2ToL1IsmConfigSchema,
    OffchainLookupIsmConfigSchema,
    InterchainAccountRouterIsmSchema,
    UnknownIsmConfigSchema,
  ]);

/**
 * ISM types that authenticate a message's origin/authorship, as opposed to
 * gating on local state. Used to satisfy the composition requirement of the
 * warp-route hybrid hook/ISMs, whose `moduleType()` is NULL and which
 * therefore verify flow, not authenticity.
 *
 * MEMBERSHIP CRITERION — add a type here only if the SDK deploy path
 * (HyperlaneIsmFactory) yields an instance that provably authenticates the
 * message in its POST-DEPLOY state, with no window in which a third party can
 * bind the authority it checks. Being named like a verifier does not qualify a
 * type, and neither does canonical bytecode: what matters is whether the
 * authority the contract compares against is fixed by this deploy path itself.
 * A contract whose authority is installed by a public initializer or setter
 * that the deploy path neither calls nor verifies is bindable by whoever
 * reaches it first, and an attacker-bound instance verifies attacker messages.
 *
 * Evidence for each member:
 * - MERKLE_ROOT_MULTISIG / MESSAGE_ID_MULTISIG: validators and threshold are
 *   MetaProxy metadata (StaticMultisigIsm.sol:21-25) fixed at the deterministic
 *   address the factory derives from them, so even a front-run deployment is
 *   the identical contract; verify() requires `threshold` validator signatures
 *   over the checkpoint digest (AbstractMultisigIsm.sol:97-115). No owner, no
 *   initializer.
 * - STORAGE_MERKLE_ROOT_MULTISIG / STORAGE_MESSAGE_ID_MULTISIG: deployed by
 *   constructor (deployMultisigIsm -> handleDeploy), which sets validators and
 *   threshold and calls `_disableInitializers()` (StorageMultisigIsm.sol:25-32),
 *   so `initialize` reverts for everyone and the Ownable2Step owner stays unset
 *   — `setValidatorsAndThreshold` is onlyOwner and therefore uncallable. This
 *   membership rests on THAT deploy path, not on the contract alone: the
 *   on-chain `StorageMultisigIsmFactory.deploy` instead creates a MinimalProxy
 *   and calls `initialize(msg.sender, ...)` (StorageMultisigIsm.sol:101-112),
 *   and a proxy runs no constructor, so `_disableInitializers` never applies,
 *   the owner becomes the caller and `setValidatorsAndThreshold` is callable.
 *   Moving these two types onto that factory (see the TODO in
 *   `deployMultisigIsm`) removes the property this membership rests on, so they
 *   must leave this set in the same change.
 * - WEIGHTED_MERKLE_ROOT_MULTISIG / WEIGHTED_MESSAGE_ID_MULTISIG: same
 *   MetaProxy argument, with the validator set and threshold weight in the
 *   metadata (WeightedMultisigIsm.sol:23-34); verify() accumulates weight from
 *   recovered signatures (AbstractWeightedMultisigIsm.sol:47-90).
 * - TRUSTED_RELAYER: mailbox and trustedRelayer are constructor immutables
 *   passed by this deploy path (TrustedRelayerIsm.sol:14-29); verify() returns
 *   `mailbox.processor(id) == trustedRelayer`, so only the operator-chosen
 *   relayer can make a message pass. No initializer, nothing to bind.
 *
 * Deliberately absent:
 * - ARB_L2_TO_L1 and CCIP: both are `AbstractMessageIdAuthorizedIsm`s whose
 *   `authorizedHook` is set by `setAuthorizedHook`, a PUBLIC one-shot
 *   `initializer` (AbstractMessageIdAuthorizedIsm.sol:60-66). This deploy path
 *   neither calls it (ARB is deployed with `[bridge]` alone) nor verifies it
 *   (CCIP resolves an address out of the CCIP cache), so between deployment
 *   and the operator's own binding any account can bind the ISM to a sender it
 *   controls and preverify arbitrary message ids. Canonical bytecode does not
 *   establish that missing hook identity.
 * - MAILBOX_DEFAULT: delegates to whatever the mailbox's default ISM happens to
 *   be at verification time, which cannot be verified statically here.
 * - OFFCHAIN_LOOKUP: `CCIP_READ` is an extensibility interface, not an
 *   authentication guarantee — the contract is deployed out of band and its
 *   `verify` may return true unconditionally (`TestCcipReadIsm`). Such an ISM
 *   may still be composed beside a hybrid; it just does not stand in as the
 *   authenticator.
 * - A bare address string: its type is unknowable at config-parse time, so
 *   treating it as authenticating would let a NULL-type ISM referenced by
 *   address satisfy the requirement.
 */
const AUTHENTICATING_ISM_TYPES: ReadonlySet<IsmType> = new Set<IsmType>([
  IsmType.MERKLE_ROOT_MULTISIG,
  IsmType.MESSAGE_ID_MULTISIG,
  IsmType.STORAGE_MERKLE_ROOT_MULTISIG,
  IsmType.STORAGE_MESSAGE_ID_MULTISIG,
  IsmType.WEIGHTED_MERKLE_ROOT_MULTISIG,
  IsmType.WEIGHTED_MESSAGE_ID_MULTISIG,
  IsmType.TRUSTED_RELAYER,
]);

/**
 * True if `node` authenticates on its own, or is an aggregation that cannot be
 * satisfied without one of its authenticating members.
 *
 * The threshold is load-bearing. AbstractAggregationIsm.verify runs only the
 * submodules the relayer-supplied metadata carries an entry for, and requires
 * exactly `threshold` of them to pass (AbstractAggregationIsm.sol:44-67), so
 * the relayer picks which `threshold` members are consulted. An aggregation
 * therefore authenticates only when its non-authenticating members are too few
 * to reach the threshold by themselves — otherwise the relayer satisfies it
 * with, say, an unpaused PausableIsm (PausableIsm.sol:28-33, returns true
 * unconditionally) and the authenticating member never executes.
 */
function providesAuthentication(node: IsmConfig): boolean {
  if (typeof node !== 'object' || node === null) {
    return false;
  }
  if (AUTHENTICATING_ISM_TYPES.has(node.type)) {
    return true;
  }
  if (
    node.type === IsmType.AGGREGATION ||
    node.type === IsmType.STORAGE_AGGREGATION
  ) {
    const nonAuthenticatingCount = node.modules.filter(
      (module) => !providesAuthentication(module),
    ).length;
    return nonAuthenticatingCount < node.threshold;
  }
  return false;
}

interface IsmCompositionContext {
  /** Whether every enclosing aggregation is exhaustive. */
  mandatoryPosition: boolean;
  underAggregation: boolean;
  /** Whether some enclosing mandatory aggregation supplies authentication. */
  authenticated: boolean;
  /** Whether some enclosing aggregation names a module by bare address. */
  addressModuleSibling: boolean;
}

/**
 * Validates the composition invariants of ISM types that are only safe in a
 * mandatory position:
 *
 * - BLACKLIST must be a member of an aggregation whose threshold equals its
 *   module count, so its verdict can never be outvoted.
 * - The warp-route hybrid hook/ISMs (NET_FLOW_RATE_LIMITED,
 *   DELAYED_FLOW_ROUTER) have the same requirement AND must be accompanied by
 *   an authenticating ISM. Their `moduleType()` is NULL: they meter flow, not
 *   message authenticity, so using one as a route's sole ISM lets any caller
 *   process a forged message subject only to bucket capacity (on a synthetic
 *   leg, minting arbitrary tokens).
 */
function validateIsmComposition(
  node: IsmConfig,
  path: (string | number)[],
  context: IsmCompositionContext,
  ctx: z.RefinementCtx,
): void {
  const {
    mandatoryPosition,
    underAggregation,
    authenticated,
    addressModuleSibling,
  } = context;

  if (typeof node === 'string') {
    return;
  }

  switch (node.type) {
    case IsmType.BLACKLIST:
      if (!(mandatoryPosition && underAggregation)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'A blacklist ISM must be a member of an aggregation whose threshold equals its module count; it cannot be used standalone, as a routing target, or under a non-exhaustive aggregation.',
          path,
        });
      }
      break;
    case IsmType.NET_FLOW_RATE_LIMITED:
    case IsmType.DELAYED_FLOW_ROUTER:
      if (!(mandatoryPosition && underAggregation)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `A ${node.type} verifies flow, not message authenticity (moduleType is NULL), so it must be a member of an aggregation whose threshold equals its module count; it cannot be used standalone, as a routing target, or under a non-exhaustive aggregation.`,
          path,
        });
      } else if (!authenticated) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `A ${node.type} must be composed with an authenticating ISM (e.g. a multisig) in the same mandatory aggregation; on its own it lets any caller process a forged message subject only to bucket capacity.` +
            (addressModuleSibling
              ? ` A module given as a bare address does not count — an already-deployed ISM has to be declared by type: re-declaring a static multisig with the same validators and threshold resolves to its existing address.`
              : ''),
          path,
        });
      }
      break;
    case IsmType.AGGREGATION:
    case IsmType.STORAGE_AGGREGATION: {
      const childMandatory =
        mandatoryPosition && node.threshold === node.modules.length;
      // An authenticating member only guarantees authentication when it cannot
      // be outvoted, i.e. when this aggregation is itself in a mandatory
      // position and its own threshold cannot be met without that member.
      const childAuthenticated =
        authenticated || (childMandatory && providesAuthentication(node));
      const childAddressModuleSibling =
        addressModuleSibling ||
        node.modules.some((module) => typeof module === 'string');
      node.modules.forEach((subIsm, i) =>
        validateIsmComposition(
          subIsm,
          [...path, 'modules', i],
          {
            mandatoryPosition: childMandatory,
            underAggregation: true,
            authenticated: childAuthenticated,
            addressModuleSibling: childAddressModuleSibling,
          },
          ctx,
        ),
      );
      break;
    }
    case IsmType.ROUTING:
    case IsmType.FALLBACK_ROUTING:
    case IsmType.INCREMENTAL_ROUTING:
      for (const [chain, domainIsm] of Object.entries(node.domains)) {
        validateIsmComposition(
          domainIsm,
          [...path, 'domains', chain],
          {
            mandatoryPosition,
            underAggregation: false,
            authenticated,
            addressModuleSibling,
          },
          ctx,
        );
      }
      break;
    case IsmType.AMOUNT_ROUTING:
      validateIsmComposition(
        node.lowerIsm,
        [...path, 'lowerIsm'],
        {
          mandatoryPosition,
          underAggregation: false,
          authenticated,
          addressModuleSibling,
        },
        ctx,
      );
      validateIsmComposition(
        node.upperIsm,
        [...path, 'upperIsm'],
        {
          mandatoryPosition,
          underAggregation: false,
          authenticated,
          addressModuleSibling,
        },
        ctx,
      );
      break;
    default:
      break;
  }
}

export const IsmConfigSchema: z.ZodType<IsmConfig, z.ZodTypeDef, unknown> =
  BaseIsmConfigSchema.superRefine((data, ctx) =>
    validateIsmComposition(
      data,
      [],
      {
        mandatoryPosition: true,
        underAggregation: false,
        authenticated: false,
        addressModuleSibling: false,
      },
      ctx,
    ),
  );

/**
 * Forward-compatible ISM config schema that normalizes unknown ISM types.
 * Use this instead of IsmConfigSchema when parsing configs that may contain
 * ISM types added in newer registry versions.
 */
export const SafeParseIsmConfigSchema = z.preprocess(
  normalizeUnknownIsmTypes,
  IsmConfigSchema,
);
