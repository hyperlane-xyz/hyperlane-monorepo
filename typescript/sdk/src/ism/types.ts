import { z } from 'zod';

import {
  AbstractCcipReadIsm,
  ArbL2ToL1Ism,
  CCIPIsm,
  IAggregationIsm,
  IInterchainSecurityModule,
  IMultisigIsm,
  IRoutingIsm,
  IStaticWeightedMultisigIsm,
  InterchainAccountRouter,
  OPStackIsm,
  PausableIsm,
  RateLimitedIsm,
  TestIsm,
  TrustedRelayerIsm,
} from '@hyperlane-xyz/core';
import type {
  Address,
  Domain,
  ValueOf,
  WithAddress,
} from '@hyperlane-xyz/utils';
import {
  isEmptyAddress,
  isNullish,
  isValidAddressSealevel,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { ZHash } from '../metadata/customZodTypes.js';
import {
  ChainMap,
  OwnableConfig,
  OwnableSchema,
  PausableSchema,
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

export type OffchainLookupIsmConfig = z.infer<
  typeof OffchainLookupIsmConfigSchema
>;

export type NullIsmConfig =
  | TestIsmConfig
  | PausableIsmConfig
  | OpStackIsmConfig
  | TrustedRelayerIsmConfig
  | CCIPIsmConfig
  | RateLimitedIsmConfig;

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

export const RateLimitedIsmConfigSchema = z
  .object({
    type: z.literal(IsmType.RATE_LIMITED),
    maxCapacity: z
      .string()
      .regex(/^\d+$/, 'maxCapacity must be a base-10 integer string'),
    recipient: ZHash.optional(),
    owner: ZHash.optional(),
  })
  .refine((val) => BigInt(val.maxCapacity) >= 86400n, {
    message: 'maxCapacity must be at least 86400',
    path: ['maxCapacity'],
  })
  .transform((val) => {
    const capacity = BigInt(val.maxCapacity);
    if (capacity % 86400n !== 0n) {
      const rounded = ((capacity / 86400n) * 86400n).toString();
      rootLogger.warn(
        `RateLimitedIsm maxCapacity ${val.maxCapacity} is not divisible by 86400; rounding down to ${rounded}`,
      );
      return { ...val, maxCapacity: rounded };
    }
    return val;
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

export const RoutingIsmConfigSchema: z.ZodSchema<RoutingIsmConfig> = z.lazy(
  () =>
    z.discriminatedUnion('type', [
      z.object({
        type: z.literal(IsmType.AMOUNT_ROUTING),
        lowerIsm: IsmConfigSchema,
        upperIsm: IsmConfigSchema,
        threshold: z.number(),
      }),
      OwnableSchema.extend({
        type: z.enum([
          IsmType.ROUTING,
          IsmType.FALLBACK_ROUTING,
          IsmType.INCREMENTAL_ROUTING,
        ]),
        domains: z.record(IsmConfigSchema),
      }),
      InterchainAccountRouterIsmSchema,
    ]),
);

export const AggregationIsmConfigSchema: z.ZodSchema<AggregationIsmConfig> = z
  .lazy(() =>
    z.object({
      type: z.union([
        z.literal(IsmType.AGGREGATION),
        z.literal(IsmType.STORAGE_AGGREGATION),
      ]),
      modules: z.array(IsmConfigSchema),
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

export const IsmConfigSchema: z.ZodSchema<IsmConfig> = z.union([
  ZHash,
  TestIsmConfigSchema,
  OpStackIsmConfigSchema,
  DerivedPausableIsmConfigSchema,
  PausableIsmConfigSchema,
  TrustedRelayerIsmConfigSchema,
  CCIPIsmConfigSchema,
  RateLimitedIsmConfigSchema,
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
 * Forward-compatible ISM config schema that normalizes unknown ISM types.
 * Use this instead of IsmConfigSchema when parsing configs that may contain
 * ISM types added in newer registry versions.
 */
export const SafeParseIsmConfigSchema = z.preprocess(
  normalizeUnknownIsmTypes,
  IsmConfigSchema,
);
