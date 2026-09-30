import {
  type NonEmptyArray,
  WithAddress,
  assert,
  deepEquals,
  isNullish,
  nonEmptyArray,
  normalizeConfig,
} from '@hyperlane-xyz/utils';

import { IsmType as AltVMIsmType } from './altvm.js';
import {
  Artifact,
  ArtifactDeployed,
  ArtifactNew,
  ArtifactReader,
  ArtifactState,
  ArtifactWriter,
  ConfigOnChain,
  IArtifactManager,
  isArtifactDeployed,
  isArtifactNew,
  isArtifactUnderived,
} from './artifact.js';
import { ChainLookup } from './chain.js';
import { ProtocolType } from './protocolType.js';

function assertNever(value: never, context: string): never {
  throw new Error(`Unhandled ISM type in ${context}: ${String(value)}`);
}

function throwUnhandledIsmType(
  config: { type: string },
  context: string,
): never {
  throw new Error(`Unhandled ISM type in ${context}: ${config.type}`);
}

export type IsmModuleType = {
  config: IsmConfig;
  derived: DerivedIsmConfig;
  addresses: IsmModuleAddresses;
};

// This catalog is shared by deployment and checking code.
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
  /**
   * Ownerless routing ISM that always delegates to the mailbox default ISM.
   * Distinct from a zero-address mailbox field: this is a deployed contract
   * with its own address.
   */
  MAILBOX_DEFAULT: 'defaultIsm',
  /**
   * Hybrid hook/ISM: one contract instance is installed as both the hook and
   * the ISM of a single warp router, sharing bucket state. It is deployed
   * through the ISM configuration; the hook side is referenced by address.
   */
  NET_FLOW_RATE_LIMITED: 'netFlowRateLimitedHookIsm',
  /** ISM configuration surface for the DelayedFlowRouterHookIsm hybrid. */
  DELAYED_FLOW_ROUTER: 'delayedFlowRouterHookIsm',
  UNKNOWN: 'unknownIsm',
} as const;

export type IsmType = (typeof IsmType)[keyof typeof IsmType];

export interface IsmConfigs {
  [IsmType.ROUTING]: DomainRoutingIsmConfig;
  [IsmType.AGGREGATION]: StaticAggregationIsmConfig;
  [IsmType.MERKLE_ROOT_MULTISIG]: MerkleRootMultisigIsmConfig;
  [IsmType.MESSAGE_ID_MULTISIG]: MessageIdMultisigIsmConfig;
  [IsmType.TEST_ISM]: TestIsmConfig;
  [IsmType.PAUSABLE]: PausableIsmConfig;
  [IsmType.COMPOSITE]: CompositeIsmConfig;
}

export type IsmConfigType = keyof IsmConfigs;
export type IsmConfig = IsmConfigs[IsmConfigType];
export type DerivedIsmConfig = WithAddress<IsmConfig>;

/** ISM types with immutable configuration embedded in bytecode via MetaProxy. */
export const STATIC_ISM_TYPES = [
  IsmType.AGGREGATION,
  IsmType.MERKLE_ROOT_MULTISIG,
  IsmType.MESSAGE_ID_MULTISIG,
  IsmType.WEIGHTED_MERKLE_ROOT_MULTISIG,
  IsmType.WEIGHTED_MESSAGE_ID_MULTISIG,
] as const satisfies readonly IsmType[];

export type StaticIsmType = (typeof STATIC_ISM_TYPES)[number];

export function isStaticIsmType(ismType: IsmType): ismType is StaticIsmType {
  return STATIC_ISM_TYPES.some((staticType) => staticType === ismType);
}

/** ISM types whose configuration can be updated in place. */
export const MUTABLE_ISM_TYPE = [
  IsmType.ROUTING,
  IsmType.INCREMENTAL_ROUTING,
  IsmType.FALLBACK_ROUTING,
  IsmType.PAUSABLE,
  IsmType.OFFCHAIN_LOOKUP,
  IsmType.RATE_LIMITED,
  IsmType.BLACKLIST,
  // Only the owner is mutable; rate parameters require redeployment.
  IsmType.NET_FLOW_RATE_LIMITED,
  // Owner and remote routers are mutable; rate parameters require redeployment.
  IsmType.DELAYED_FLOW_ROUTER,
] as const satisfies readonly IsmType[];

export type MutableIsmType = (typeof MUTABLE_ISM_TYPE)[number];

export function isMutableIsmConfig<T extends { type: IsmType }>(
  config: T,
): config is Extract<T, { type: MutableIsmType }> {
  return MUTABLE_ISM_TYPE.some((mutableType) => mutableType === config.type);
}

export interface OwnableIsmConfig {
  owner: string;
}

export interface OpStackIsmConfig {
  type: typeof IsmType.OP_STACK;
  origin: string;
  nativeBridge: string;
}

export interface MultisigIsmConfig<
  T extends
    | typeof IsmType.MERKLE_ROOT_MULTISIG
    | typeof IsmType.MESSAGE_ID_MULTISIG
    | typeof IsmType.STORAGE_MERKLE_ROOT_MULTISIG
    | typeof IsmType.STORAGE_MESSAGE_ID_MULTISIG =
    | typeof IsmType.MERKLE_ROOT_MULTISIG
    | typeof IsmType.MESSAGE_ID_MULTISIG
    | typeof IsmType.STORAGE_MERKLE_ROOT_MULTISIG
    | typeof IsmType.STORAGE_MESSAGE_ID_MULTISIG,
> {
  type: T;
  validators: string[];
  threshold: number;
}

export type MerkleRootMultisigIsmConfig = MultisigIsmConfig<
  typeof IsmType.MERKLE_ROOT_MULTISIG
>;

export type MessageIdMultisigIsmConfig = MultisigIsmConfig<
  typeof IsmType.MESSAGE_ID_MULTISIG
>;

export type StorageMerkleRootMultisigIsmConfig = MultisigIsmConfig<
  typeof IsmType.STORAGE_MERKLE_ROOT_MULTISIG
>;

export type StorageMessageIdMultisigIsmConfig = MultisigIsmConfig<
  typeof IsmType.STORAGE_MESSAGE_ID_MULTISIG
>;

export interface WeightedMultisigIsmConfig<
  T extends
    | typeof IsmType.WEIGHTED_MERKLE_ROOT_MULTISIG
    | typeof IsmType.WEIGHTED_MESSAGE_ID_MULTISIG =
    | typeof IsmType.WEIGHTED_MERKLE_ROOT_MULTISIG
    | typeof IsmType.WEIGHTED_MESSAGE_ID_MULTISIG,
> {
  type: T;
  validators: NonEmptyArray<{ signingAddress: string; weight: number }>;
  thresholdWeight: number;
}

export type WeightedMerkleRootMultisigIsmConfig = WeightedMultisigIsmConfig<
  typeof IsmType.WEIGHTED_MERKLE_ROOT_MULTISIG
>;

export type WeightedMessageIdMultisigIsmConfig = WeightedMultisigIsmConfig<
  typeof IsmType.WEIGHTED_MESSAGE_ID_MULTISIG
>;

export interface TestIsmConfig {
  type: typeof IsmType.TEST_ISM;
}

export interface AggregationIsmConfig<
  T extends typeof IsmType.AGGREGATION | typeof IsmType.STORAGE_AGGREGATION =
    typeof IsmType.AGGREGATION,
> {
  type: T;
  modules: NonEmptyArray<IsmConfig | string>;
  threshold: number;
}

export type StaticAggregationIsmConfig = AggregationIsmConfig<
  typeof IsmType.AGGREGATION
>;

export type StorageAggregationIsmConfig = AggregationIsmConfig<
  typeof IsmType.STORAGE_AGGREGATION
>;

export interface PausableIsmConfig extends OwnableIsmConfig {
  type: typeof IsmType.PAUSABLE;
  paused: boolean;
}

export interface DomainRoutingIsmConfig<
  T extends
    | typeof IsmType.ROUTING
    | typeof IsmType.INCREMENTAL_ROUTING
    | typeof IsmType.FALLBACK_ROUTING = typeof IsmType.ROUTING,
> extends OwnableIsmConfig {
  type: T;
  domains: Record<string, IsmConfig | string>;
}

export type IncrementalDomainRoutingIsmConfig = DomainRoutingIsmConfig<
  typeof IsmType.INCREMENTAL_ROUTING
>;

export type DefaultFallbackRoutingIsmConfig = DomainRoutingIsmConfig<
  typeof IsmType.FALLBACK_ROUTING
>;

export interface AmountRoutingIsmConfig {
  type: typeof IsmType.AMOUNT_ROUTING;
  lowerIsm: IsmConfig | string;
  upperIsm: IsmConfig | string;
  threshold: number;
}

export interface InterchainAccountRoutingIsmConfig extends OwnableIsmConfig {
  type: typeof IsmType.INTERCHAIN_ACCOUNT_ROUTING;
  isms: Record<string, string>;
}

export interface TrustedRelayerIsmConfig {
  type: typeof IsmType.TRUSTED_RELAYER;
  relayer: string;
}

export interface ArbL2ToL1IsmConfig {
  type: typeof IsmType.ARB_L2_TO_L1;
  bridge: string;
}

export interface CcipIsmConfig {
  type: typeof IsmType.CCIP;
  originChain: string;
}

export interface OffchainLookupIsmConfig extends OwnableIsmConfig {
  type: typeof IsmType.OFFCHAIN_LOOKUP;
  urls: NonEmptyArray<string>;
}

export interface RateLimitedIsmConfig {
  type: typeof IsmType.RATE_LIMITED;
  maxCapacity: string;
  duration: bigint;
  recipient?: string;
  owner?: string;
}

export interface BlacklistIsmConfig extends OwnableIsmConfig {
  type: typeof IsmType.BLACKLIST;
  blacklistedIds: string[];
}

export interface MailboxDefaultIsmConfig {
  type: typeof IsmType.MAILBOX_DEFAULT;
}

export interface NetFlowRateLimitedHookIsmConfig {
  type: typeof IsmType.NET_FLOW_RATE_LIMITED;
  warpRouter?: string;
  thresholdBps: number;
  duration: bigint;
  owner?: string;
}

export interface DelayedFlowRouterHookIsmConfig extends OwnableIsmConfig {
  type: typeof IsmType.DELAYED_FLOW_ROUTER;
  warpRouter?: string;
  thresholdBps: number;
  maxDelay: number;
  duration: bigint;
  remoteIsms?: Record<string, string>;
}

export interface UnknownIsmConfig {
  type: typeof IsmType.UNKNOWN;
  [key: string]: unknown;
}

/**
 * Discriminants for composite ISM tree nodes — used to compare/narrow
 * `CompositeIsmNodeConfig`/`CompositeIsmNodeArtifactConfig` without
 * hardcoding string literals at each comparison site.
 */
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

/**
 * A node in a Sealevel-only "composite ISM" tree (one program storing the
 * whole tree in a single PDA). Sub-nodes are inline Borsh data, not separate
 * deployments — only `routing`/`fallbackRouting.domains` are chain-name keyed
 * (config-file-only; diffed into per-domain instructions by the writer).
 */
export type CompositeIsmNodeConfig =
  | { type: typeof CompositeIsmNodeType.TRUSTED_RELAYER; relayer: string }
  | {
      type: typeof CompositeIsmNodeType.MULTISIG_MESSAGE_ID;
      validators: NonEmptyArray<string>;
      threshold: number;
    }
  | {
      type: typeof CompositeIsmNodeType.AGGREGATION;
      threshold: number;
      subIsms: NonEmptyArray<CompositeIsmNodeConfig>;
    }
  | { type: typeof CompositeIsmNodeType.TEST; accept: boolean }
  | { type: typeof CompositeIsmNodeType.PAUSABLE; paused: boolean }
  | {
      type: typeof CompositeIsmNodeType.AMOUNT_ROUTING;
      threshold: string;
      lower: CompositeIsmNodeConfig;
      upper: CompositeIsmNodeConfig;
    }
  | {
      type: typeof CompositeIsmNodeType.RATE_LIMITED;
      maxCapacity: string;
      mailbox: string;
      recipient?: string;
    }
  | {
      type: typeof CompositeIsmNodeType.ROUTING;
      domains?: Record<string, CompositeIsmNodeConfig>;
    }
  | {
      type: typeof CompositeIsmNodeType.FALLBACK_ROUTING;
      fallbackIsm: string;
      domains?: Record<string, CompositeIsmNodeConfig>;
    };

export interface CompositeIsmConfig {
  type: typeof IsmType.COMPOSITE;
  owner: string;
  root: CompositeIsmNodeConfig;
}

export type IsmModuleAddresses = {
  deployedIsm: string;
  mailbox: string;
};

// Artifact API types

export interface DeployedIsmAddress {
  address: string;
}

export interface OpStackIsmArtifactConfig {
  type: typeof IsmType.OP_STACK;
  originDomain: number;
  nativeBridge: string;
}

export interface IsmArtifactConfigs {
  /** User-facing custom ISMs are opaque to the Artifact API. */
  [IsmType.CUSTOM]: UnknownIsmConfig;
  [IsmType.OP_STACK]: OpStackIsmArtifactConfig;
  [IsmType.ROUTING]: DomainRoutingIsmArtifactConfig;
  [IsmType.INCREMENTAL_ROUTING]: IncrementalDomainRoutingIsmArtifactConfig;
  [IsmType.FALLBACK_ROUTING]: DefaultFallbackRoutingIsmArtifactConfig;
  [IsmType.AMOUNT_ROUTING]: AmountRoutingIsmArtifactConfig;
  [IsmType.INTERCHAIN_ACCOUNT_ROUTING]: InterchainAccountRoutingIsmArtifactConfig;
  [IsmType.AGGREGATION]: StaticAggregationIsmArtifactConfig;
  [IsmType.STORAGE_AGGREGATION]: StorageAggregationIsmArtifactConfig;
  [IsmType.MERKLE_ROOT_MULTISIG]: MerkleRootMultisigIsmConfig;
  [IsmType.MESSAGE_ID_MULTISIG]: MessageIdMultisigIsmConfig;
  [IsmType.STORAGE_MERKLE_ROOT_MULTISIG]: StorageMerkleRootMultisigIsmConfig;
  [IsmType.STORAGE_MESSAGE_ID_MULTISIG]: StorageMessageIdMultisigIsmConfig;
  [IsmType.TEST_ISM]: TestIsmConfig;
  [IsmType.PAUSABLE]: PausableIsmConfig;
  [IsmType.TRUSTED_RELAYER]: TrustedRelayerIsmConfig;
  [IsmType.ARB_L2_TO_L1]: ArbL2ToL1IsmConfig;
  [IsmType.WEIGHTED_MERKLE_ROOT_MULTISIG]: WeightedMerkleRootMultisigIsmConfig;
  [IsmType.WEIGHTED_MESSAGE_ID_MULTISIG]: WeightedMessageIdMultisigIsmConfig;
  [IsmType.CCIP]: CcipIsmArtifactConfig;
  [IsmType.OFFCHAIN_LOOKUP]: OffchainLookupIsmConfig;
  [IsmType.RATE_LIMITED]: RateLimitedIsmConfig;
  [IsmType.COMPOSITE]: CompositeIsmArtifactConfig;
  [IsmType.BLACKLIST]: BlacklistIsmConfig;
  [IsmType.MAILBOX_DEFAULT]: MailboxDefaultIsmConfig;
  [IsmType.NET_FLOW_RATE_LIMITED]: NetFlowRateLimitedHookIsmConfig;
  [IsmType.DELAYED_FLOW_ROUTER]: DelayedFlowRouterHookIsmArtifactConfig;
  [IsmType.UNKNOWN]: UnknownIsmConfig;
}

/**
 * Should be used for the specific artifact code that
 * deploys or reads any kind of ISM and its nested configs (Routing, Aggregation, ...)
 */
export type IsmArtifactConfig = IsmArtifactConfigs[IsmType];

export type MutableIsmArtifactConfig = Extract<
  IsmArtifactConfig,
  { type: MutableIsmType }
>;

type LegacyIsmArtifactConfig = IsmArtifactConfigs[IsmConfigType];

function isLegacyIsmArtifactConfig(
  config: IsmArtifactConfig,
): config is LegacyIsmArtifactConfig {
  switch (config.type) {
    case IsmType.ROUTING:
    case IsmType.AGGREGATION:
    case IsmType.MERKLE_ROOT_MULTISIG:
    case IsmType.MESSAGE_ID_MULTISIG:
    case IsmType.TEST_ISM:
    case IsmType.PAUSABLE:
    case IsmType.COMPOSITE:
      return true;
    case IsmType.OP_STACK:
    case IsmType.INCREMENTAL_ROUTING:
    case IsmType.FALLBACK_ROUTING:
    case IsmType.AMOUNT_ROUTING:
    case IsmType.INTERCHAIN_ACCOUNT_ROUTING:
    case IsmType.STORAGE_AGGREGATION:
    case IsmType.STORAGE_MERKLE_ROOT_MULTISIG:
    case IsmType.STORAGE_MESSAGE_ID_MULTISIG:
    case IsmType.TRUSTED_RELAYER:
    case IsmType.ARB_L2_TO_L1:
    case IsmType.WEIGHTED_MERKLE_ROOT_MULTISIG:
    case IsmType.WEIGHTED_MESSAGE_ID_MULTISIG:
    case IsmType.CCIP:
    case IsmType.OFFCHAIN_LOOKUP:
    case IsmType.RATE_LIMITED:
    case IsmType.BLACKLIST:
    case IsmType.MAILBOX_DEFAULT:
    case IsmType.NET_FLOW_RATE_LIMITED:
    case IsmType.DELAYED_FLOW_ROUTER:
    case IsmType.UNKNOWN:
      return false;
    default:
      return assertNever(config, 'isLegacyIsmArtifactConfig');
  }
}

export type DirectIsmArtifactConfig = Exclude<
  IsmArtifactConfig,
  | IsmArtifactConfigs[typeof IsmType.ROUTING]
  | IsmArtifactConfigs[typeof IsmType.INCREMENTAL_ROUTING]
  | IsmArtifactConfigs[typeof IsmType.FALLBACK_ROUTING]
  | IsmArtifactConfigs[typeof IsmType.AMOUNT_ROUTING]
  | IsmArtifactConfigs[typeof IsmType.AGGREGATION]
  | IsmArtifactConfigs[typeof IsmType.STORAGE_AGGREGATION]
>;

export function isDirectIsmArtifactConfig(
  config: IsmArtifactConfig,
): config is DirectIsmArtifactConfig {
  switch (config.type) {
    case IsmType.ROUTING:
    case IsmType.INCREMENTAL_ROUTING:
    case IsmType.FALLBACK_ROUTING:
    case IsmType.AMOUNT_ROUTING:
    case IsmType.AGGREGATION:
    case IsmType.STORAGE_AGGREGATION:
      return false;
    case IsmType.OP_STACK:
    case IsmType.INTERCHAIN_ACCOUNT_ROUTING:
    case IsmType.MERKLE_ROOT_MULTISIG:
    case IsmType.MESSAGE_ID_MULTISIG:
    case IsmType.STORAGE_MERKLE_ROOT_MULTISIG:
    case IsmType.STORAGE_MESSAGE_ID_MULTISIG:
    case IsmType.TEST_ISM:
    case IsmType.PAUSABLE:
    case IsmType.TRUSTED_RELAYER:
    case IsmType.ARB_L2_TO_L1:
    case IsmType.WEIGHTED_MERKLE_ROOT_MULTISIG:
    case IsmType.WEIGHTED_MESSAGE_ID_MULTISIG:
    case IsmType.CCIP:
    case IsmType.OFFCHAIN_LOOKUP:
    case IsmType.RATE_LIMITED:
    case IsmType.COMPOSITE:
    case IsmType.BLACKLIST:
    case IsmType.MAILBOX_DEFAULT:
    case IsmType.NET_FLOW_RATE_LIMITED:
    case IsmType.DELAYED_FLOW_ROUTER:
    case IsmType.UNKNOWN:
      return true;
    default:
      return assertNever(config, 'isDirectIsmArtifactConfig');
  }
}

/**
 * Describes the configuration of deployed ISM and its nested configs (Routing, Aggregation, ...)
 */
export type DeployedIsmArtifact = ArtifactDeployed<
  IsmArtifactConfig,
  DeployedIsmAddress
>;

/**
 * Should be used to implement an object/closure or class that is in charge of coordinating
 * deployment of an ISM config which might include nested ISM deployments (Routing, Aggregation, ...)
 */
export type IIsmArtifactManager = IArtifactManager<
  IsmType,
  IsmArtifactConfigs,
  DeployedIsmAddress
>;

export interface RoutingIsmArtifactConfig<
  T extends
    | typeof IsmType.ROUTING
    | typeof IsmType.INCREMENTAL_ROUTING
    | typeof IsmType.FALLBACK_ROUTING = typeof IsmType.ROUTING,
> {
  type: T;
  owner: string;
  domains: Record<number, Artifact<IsmArtifactConfig, DeployedIsmAddress>>;
}

export type DomainRoutingIsmArtifactConfig = RoutingIsmArtifactConfig<
  typeof IsmType.ROUTING
>;

export type IncrementalDomainRoutingIsmArtifactConfig =
  RoutingIsmArtifactConfig<typeof IsmType.INCREMENTAL_ROUTING>;

export type DefaultFallbackRoutingIsmArtifactConfig = RoutingIsmArtifactConfig<
  typeof IsmType.FALLBACK_ROUTING
>;

export type AnyDomainRoutingIsmArtifactConfig =
  | DomainRoutingIsmArtifactConfig
  | IncrementalDomainRoutingIsmArtifactConfig
  | DefaultFallbackRoutingIsmArtifactConfig;

export interface AmountRoutingIsmArtifactConfig {
  type: typeof IsmType.AMOUNT_ROUTING;
  lowerIsm: Artifact<IsmArtifactConfig, DeployedIsmAddress>;
  upperIsm: Artifact<IsmArtifactConfig, DeployedIsmAddress>;
  threshold: number;
}

export interface InterchainAccountRoutingIsmArtifactConfig extends OwnableIsmConfig {
  type: typeof IsmType.INTERCHAIN_ACCOUNT_ROUTING;
  isms: Record<number, string>;
}

export interface AggregationIsmArtifactConfig<
  T extends typeof IsmType.AGGREGATION | typeof IsmType.STORAGE_AGGREGATION =
    typeof IsmType.AGGREGATION,
> {
  type: T;
  modules: NonEmptyArray<Artifact<IsmArtifactConfig, DeployedIsmAddress>>;
  threshold: number;
}

export type StaticAggregationIsmArtifactConfig = AggregationIsmArtifactConfig<
  typeof IsmType.AGGREGATION
>;

export type StorageAggregationIsmArtifactConfig = AggregationIsmArtifactConfig<
  typeof IsmType.STORAGE_AGGREGATION
>;

export interface CcipIsmArtifactConfig {
  type: typeof IsmType.CCIP;
  originDomain: number;
}

export interface DelayedFlowRouterHookIsmArtifactConfig extends Omit<
  DelayedFlowRouterHookIsmConfig,
  'remoteIsms'
> {
  remoteIsms?: Record<number, string>;
}

export type RawStaticAggregationIsmArtifactConfig =
  ConfigOnChain<StaticAggregationIsmArtifactConfig>;

export type RawStorageAggregationIsmArtifactConfig =
  ConfigOnChain<StorageAggregationIsmArtifactConfig>;

export type RawAggregationIsmArtifactConfig =
  RawStaticAggregationIsmArtifactConfig;

export type RawDomainRoutingIsmArtifactConfig =
  ConfigOnChain<DomainRoutingIsmArtifactConfig>;

export type RawIncrementalDomainRoutingIsmArtifactConfig =
  ConfigOnChain<IncrementalDomainRoutingIsmArtifactConfig>;

export type RawDefaultFallbackRoutingIsmArtifactConfig =
  ConfigOnChain<DefaultFallbackRoutingIsmArtifactConfig>;

export type RawRoutingIsmArtifactConfig = RawDomainRoutingIsmArtifactConfig;

export type RawAmountRoutingIsmArtifactConfig =
  ConfigOnChain<AmountRoutingIsmArtifactConfig>;

/**
 * Artifact-API mirror of CompositeIsmNodeConfig: `routing`/`fallbackRouting.domains`
 * are keyed by domain ID instead of chain name. Otherwise identical — sub-nodes
 * are never separately-deployed Artifacts, so there's no distinct "raw" shape
 * (unlike domainRoutingIsm, whose domains wrap nested Artifact<> objects).
 */
export type CompositeIsmNodeArtifactConfig =
  | { type: typeof CompositeIsmNodeType.TRUSTED_RELAYER; relayer: string }
  | {
      type: typeof CompositeIsmNodeType.MULTISIG_MESSAGE_ID;
      validators: NonEmptyArray<string>;
      threshold: number;
    }
  | {
      type: typeof CompositeIsmNodeType.AGGREGATION;
      threshold: number;
      subIsms: NonEmptyArray<CompositeIsmNodeArtifactConfig>;
    }
  | { type: typeof CompositeIsmNodeType.TEST; accept: boolean }
  | { type: typeof CompositeIsmNodeType.PAUSABLE; paused: boolean }
  | {
      type: typeof CompositeIsmNodeType.AMOUNT_ROUTING;
      threshold: string;
      lower: CompositeIsmNodeArtifactConfig;
      upper: CompositeIsmNodeArtifactConfig;
    }
  | {
      type: typeof CompositeIsmNodeType.RATE_LIMITED;
      maxCapacity: string;
      mailbox: string;
      recipient?: string;
    }
  | {
      type: typeof CompositeIsmNodeType.ROUTING;
      domains?: Record<number, CompositeIsmNodeArtifactConfig>;
    }
  | {
      type: typeof CompositeIsmNodeType.FALLBACK_ROUTING;
      fallbackIsm: string;
      domains?: Record<number, CompositeIsmNodeArtifactConfig>;
    };

export interface CompositeIsmArtifactConfig {
  type: typeof IsmType.COMPOSITE;
  owner: string;
  root: CompositeIsmNodeArtifactConfig;
}

export type RawIsmArtifactConfigs = {
  [K in IsmType]: ConfigOnChain<IsmArtifactConfigs[K]>;
};

export type IsmArtifactReaderFactories<D = DeployedIsmAddress> = Partial<{
  [K in IsmType]: () => ArtifactReader<RawIsmArtifactConfigs[K], D>;
}>;

export type IsmArtifactWriterFactories<D = DeployedIsmAddress> = Partial<{
  [K in IsmType]: () => ArtifactWriter<RawIsmArtifactConfigs[K], D>;
}>;

export class UnsupportedIsmArtifactTypeError extends Error {
  constructor(
    public readonly ismType: string,
    public readonly protocol: ProtocolType,
  ) {
    super(`Unsupported ISM artifact type ${ismType} for protocol ${protocol}`);
    this.name = 'UnsupportedIsmArtifactTypeError';
  }
}

export function throwUnsupportedIsmType(
  ismType: string,
  protocol: ProtocolType,
): never {
  throw new UnsupportedIsmArtifactTypeError(ismType, protocol);
}

/**
 * Should be used for the specific artifact code that
 * deploys or reads a single artifact on chain
 */
export type RawIsmArtifactConfig = RawIsmArtifactConfigs[IsmType];

/**
 * Describes the configuration of deployed ISM without nested config expansion (Routing, Aggregation, ...)
 */
export type DeployedRawIsmArtifact = ArtifactDeployed<
  RawIsmArtifactConfig,
  DeployedIsmAddress
>;

/**
 * Should be used to implement an object/closure or class that individually deploys
 * ISMs on chain
 */
export interface IRawIsmArtifactManager extends IArtifactManager<
  IsmType,
  RawIsmArtifactConfigs,
  DeployedIsmAddress
> {
  /**
   * Read any ISM by detecting its type and delegating to the appropriate reader.
   * This is the generic entry point for reading ISMs of unknown types.
   * @param address The on-chain address of the ISM
   * @returns The artifact configuration and deployment data
   */
  readIsm(address: string): Promise<DeployedRawIsmArtifact>;
}

/**
 * Determines if a new ISM should be deployed instead of updating the existing one.
 * Deploy new ISM if:
 * - ISM type changed
 * - Static/immutable configuration changed
 * - An immutable field of a partially mutable ISM changed
 *
 * For routing ISMs, config changes don't trigger redeployment as they support updates.
 *
 * @param actual The current deployed ISM configuration
 * @param expected The desired ISM configuration
 * @returns true if a new ISM should be deployed, false if existing can be updated
 */
export function shouldDeployNewIsm(
  actual: IsmArtifactConfig,
  expected: IsmArtifactConfig,
): boolean {
  assert(
    expected.type !== IsmType.AGGREGATION &&
      expected.type !== IsmType.STORAGE_AGGREGATION,
    'Aggregation ISM artifact composition is not yet supported',
  );

  // Type changed - must deploy new
  if (actual.type !== expected.type) return true;

  // Normalize and compare configs (handles address casing, validator order, etc.)
  const normalizedActual: IsmArtifactConfig = normalizeConfig(actual);
  const normalizedExpected: IsmArtifactConfig = normalizeConfig(expected);

  if (
    normalizedActual.type === IsmType.RATE_LIMITED &&
    normalizedExpected.type === IsmType.RATE_LIMITED
  ) {
    return (
      normalizedActual.duration !== normalizedExpected.duration ||
      (normalizedExpected.recipient !== undefined &&
        normalizedActual.recipient !== normalizedExpected.recipient)
    );
  }

  if (
    normalizedActual.type === IsmType.NET_FLOW_RATE_LIMITED &&
    normalizedExpected.type === IsmType.NET_FLOW_RATE_LIMITED
  ) {
    return (
      normalizedActual.duration !== normalizedExpected.duration ||
      normalizedActual.thresholdBps !== normalizedExpected.thresholdBps ||
      (normalizedExpected.warpRouter !== undefined &&
        normalizedActual.warpRouter !== normalizedExpected.warpRouter)
    );
  }

  if (
    normalizedActual.type === IsmType.DELAYED_FLOW_ROUTER &&
    normalizedExpected.type === IsmType.DELAYED_FLOW_ROUTER
  ) {
    return (
      normalizedActual.duration !== normalizedExpected.duration ||
      normalizedActual.thresholdBps !== normalizedExpected.thresholdBps ||
      normalizedActual.maxDelay !== normalizedExpected.maxDelay ||
      (normalizedExpected.warpRouter !== undefined &&
        normalizedActual.warpRouter !== normalizedExpected.warpRouter)
    );
  }

  if (
    normalizedActual.type === IsmType.BLACKLIST &&
    normalizedExpected.type === IsmType.BLACKLIST
  ) {
    const targetIds = new Set(normalizedExpected.blacklistedIds);
    return normalizedActual.blacklistedIds.some((id) => !targetIds.has(id));
  }

  // For static ISM types, they're immutable - must redeploy if config differs
  if (isStaticIsmType(expected.type)) {
    return !deepEquals(normalizedActual, normalizedExpected);
  }

  // Mutable ISMs and the self-diffing composite ISM update in place.
  if (expected.type === IsmType.COMPOSITE || isMutableIsmConfig(expected)) {
    return false;
  }

  // Remaining direct and dynamically routed ISMs are immutable.
  return !deepEquals(normalizedActual, normalizedExpected);
}

/**
 * Merges current (on-chain) and expected ISM artifacts, preserving DEPLOYED state
 * for unchanged nested ISMs in routing configurations.
 *
 * This prevents unnecessary redeployment of domain ISMs when only mutable properties
 * (like routing ISM owner) change.
 *
 * @param currentArtifact Deployed ISM artifact from chain (undefined if not deployed)
 * @param expectedArtifact Expected ISM configuration (from user config)
 * @returns Merged artifact with appropriate deployment states
 */
export function mergeIsmArtifacts(
  currentArtifact: DeployedIsmArtifact | undefined,
  expectedArtifact: ArtifactNew<IsmArtifactConfig> | DeployedIsmArtifact,
): ArtifactNew<IsmArtifactConfig> | DeployedIsmArtifact {
  assert(
    expectedArtifact.config.type !== IsmType.AGGREGATION &&
      expectedArtifact.config.type !== IsmType.STORAGE_AGGREGATION,
    'Aggregation ISM artifact composition is not yet supported',
  );

  const expectedConfig = expectedArtifact.config;

  // No current ISM - return expected as-is
  if (!currentArtifact) {
    return expectedArtifact;
  }

  const currentConfig = currentArtifact.config;

  // Type changed - must deploy new
  if (currentConfig.type !== expectedConfig.type) {
    return {
      artifactState: ArtifactState.NEW,
      config: expectedConfig,
    };
  }

  if (shouldDeployNewIsm(currentConfig, expectedConfig)) {
    return {
      artifactState: ArtifactState.NEW,
      config: expectedConfig,
    };
  }

  const isRoutingConfig = (
    config: IsmArtifactConfig,
  ): config is AnyDomainRoutingIsmArtifactConfig =>
    config.type === IsmType.ROUTING ||
    config.type === IsmType.INCREMENTAL_ROUTING ||
    config.type === IsmType.FALLBACK_ROUTING;

  if (!isRoutingConfig(expectedConfig)) {
    const deployedAddress = isArtifactDeployed(expectedArtifact)
      ? expectedArtifact.deployed
      : currentArtifact.deployed;

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: expectedConfig,
      deployed: deployedAddress,
    };
  }

  assert(
    isRoutingConfig(currentConfig),
    `Expected matching routing ISM configs, got ${currentConfig.type} and ${expectedConfig.type}`,
  );

  // Merge domain ISMs recursively
  const mergedDomains: Record<
    number,
    Artifact<IsmArtifactConfig, DeployedIsmAddress>
  > = {};

  for (const [domainIdStr, expectedDomainIsm] of Object.entries(
    expectedConfig.domains,
  )) {
    const domainId = parseInt(domainIdStr);
    const currentDomainIsm = Object.prototype.hasOwnProperty.call(
      currentConfig.domains,
      domainId,
    )
      ? currentConfig.domains[domainId]
      : undefined;

    let currentDeployedIsm: DeployedIsmArtifact | undefined;
    if (currentDomainIsm && isArtifactDeployed(currentDomainIsm)) {
      currentDeployedIsm = currentDomainIsm;
    }

    if (
      isArtifactNew(expectedDomainIsm) ||
      isArtifactDeployed(expectedDomainIsm)
    ) {
      mergedDomains[domainId] = mergeIsmArtifacts(
        currentDeployedIsm,
        expectedDomainIsm,
      );
    } else {
      mergedDomains[domainId] = expectedDomainIsm;
    }
  }

  const deployedAddress = isArtifactDeployed(expectedArtifact)
    ? expectedArtifact.deployed
    : currentArtifact.deployed;

  return {
    artifactState: ArtifactState.DEPLOYED,
    config: {
      type: expectedConfig.type,
      owner: expectedConfig.owner,
      domains: mergedDomains,
    },
    deployed: deployedAddress,
  };
}

export function altVMIsmTypeToProviderSdkType(
  altVMType: AltVMIsmType,
): IsmType {
  switch (altVMType) {
    case AltVMIsmType.CUSTOM:
      return IsmType.UNKNOWN;
    case AltVMIsmType.OP_STACK:
      return IsmType.OP_STACK;
    case AltVMIsmType.FALLBACK_ROUTING:
      return IsmType.FALLBACK_ROUTING;
    case AltVMIsmType.AMOUNT_ROUTING:
      return IsmType.AMOUNT_ROUTING;
    case AltVMIsmType.INTERCHAIN_ACCOUNT_ROUTING:
      return IsmType.INTERCHAIN_ACCOUNT_ROUTING;
    case AltVMIsmType.TEST_ISM:
      return IsmType.TEST_ISM;
    case AltVMIsmType.MERKLE_ROOT_MULTISIG:
      return IsmType.MERKLE_ROOT_MULTISIG;
    case AltVMIsmType.MESSAGE_ID_MULTISIG:
      return IsmType.MESSAGE_ID_MULTISIG;
    case AltVMIsmType.STORAGE_MERKLE_ROOT_MULTISIG:
      return IsmType.STORAGE_MERKLE_ROOT_MULTISIG;
    case AltVMIsmType.STORAGE_MESSAGE_ID_MULTISIG:
      return IsmType.STORAGE_MESSAGE_ID_MULTISIG;
    case AltVMIsmType.WEIGHTED_MERKLE_ROOT_MULTISIG:
      return IsmType.WEIGHTED_MERKLE_ROOT_MULTISIG;
    case AltVMIsmType.WEIGHTED_MESSAGE_ID_MULTISIG:
      return IsmType.WEIGHTED_MESSAGE_ID_MULTISIG;
    case AltVMIsmType.ROUTING:
      return IsmType.ROUTING;
    case AltVMIsmType.AGGREGATION:
      return IsmType.AGGREGATION;
    case AltVMIsmType.STORAGE_AGGREGATION:
      return IsmType.STORAGE_AGGREGATION;
    case AltVMIsmType.PAUSABLE:
      return IsmType.PAUSABLE;
    case AltVMIsmType.TRUSTED_RELAYER:
      return IsmType.TRUSTED_RELAYER;
    case AltVMIsmType.ARB_L2_TO_L1:
      return IsmType.ARB_L2_TO_L1;
    case AltVMIsmType.CCIP:
      return IsmType.CCIP;
    case AltVMIsmType.OFFCHAIN_LOOKUP:
      return IsmType.OFFCHAIN_LOOKUP;
    case AltVMIsmType.COMPOSITE:
      return IsmType.COMPOSITE;
    default:
      return assertNever(altVMType, 'altVMIsmTypeToProviderSdkType');
  }
}

/**
 * Recursively converts a composite ISM node from the Artifact API shape
 * (domain-ID-keyed `domains`) to the Config API shape (chain-name-keyed).
 * Only `routing`/`fallbackRouting.domains` need key conversion — `subIsms`
 * (array) and `amountRouting.lower`/`upper` (fixed fields) don't.
 */
function compositeIsmNodeArtifactToConfig(
  node: CompositeIsmNodeArtifactConfig,
  chainLookup: ChainLookup,
): CompositeIsmNodeConfig {
  switch (node.type) {
    case CompositeIsmNodeType.AGGREGATION:
      return {
        ...node,
        subIsms: nonEmptyArray(
          node.subIsms.map((sub) =>
            compositeIsmNodeArtifactToConfig(sub, chainLookup),
          ),
        ),
      };
    case CompositeIsmNodeType.AMOUNT_ROUTING:
      return {
        ...node,
        lower: compositeIsmNodeArtifactToConfig(node.lower, chainLookup),
        upper: compositeIsmNodeArtifactToConfig(node.upper, chainLookup),
      };
    case CompositeIsmNodeType.ROUTING:
    case CompositeIsmNodeType.FALLBACK_ROUTING: {
      if (!node.domains) {
        return { ...node, domains: undefined };
      }
      const domains: Record<string, CompositeIsmNodeConfig> = {};
      for (const [domainIdStr, domainNode] of Object.entries(node.domains)) {
        const chainName = chainLookup.getChainName(parseInt(domainIdStr, 10));
        if (!chainName) {
          // Skip unknown domains, matching domainRoutingIsm's behavior
          continue;
        }
        domains[chainName] = compositeIsmNodeArtifactToConfig(
          domainNode,
          chainLookup,
        );
      }
      return { ...node, domains };
    }
    default:
      return node;
  }
}

/**
 * Recursively converts a composite ISM node from the Config API shape
 * (chain-name-keyed `domains`) to the Artifact API shape (domain-ID-keyed).
 * Inverse of {@link compositeIsmNodeArtifactToConfig}.
 */
function compositeIsmNodeConfigToArtifact(
  node: CompositeIsmNodeConfig,
  chainLookup: ChainLookup,
): CompositeIsmNodeArtifactConfig {
  switch (node.type) {
    case CompositeIsmNodeType.AGGREGATION:
      return {
        ...node,
        subIsms: nonEmptyArray(
          node.subIsms.map((sub) =>
            compositeIsmNodeConfigToArtifact(sub, chainLookup),
          ),
        ),
      };
    case CompositeIsmNodeType.AMOUNT_ROUTING:
      return {
        ...node,
        lower: compositeIsmNodeConfigToArtifact(node.lower, chainLookup),
        upper: compositeIsmNodeConfigToArtifact(node.upper, chainLookup),
      };
    case CompositeIsmNodeType.ROUTING:
    case CompositeIsmNodeType.FALLBACK_ROUTING: {
      if (!node.domains) {
        return { ...node, domains: undefined };
      }
      const domains: Record<number, CompositeIsmNodeArtifactConfig> = {};
      for (const [chainName, domainNode] of Object.entries(node.domains)) {
        const domainId = chainLookup.getDomainId(chainName);
        if (isNullish(domainId)) {
          // Skip unknown chains, matching domainRoutingIsm's behavior
          continue;
        }
        domains[domainId] = compositeIsmNodeConfigToArtifact(
          domainNode,
          chainLookup,
        );
      }
      return { ...node, domains };
    }
    default:
      return node;
  }
}

/**
 * Walks every node of a composite ISM tree, including the nodes nested in
 * `aggregation.subIsms`, `amountRouting.lower`/`upper`, and the per-domain
 * overrides of `routing`/`fallbackRouting`.
 */
function someCompositeIsmNode(
  node: CompositeIsmNodeArtifactConfig,
  predicate: (node: CompositeIsmNodeArtifactConfig) => boolean,
): boolean {
  if (predicate(node)) return true;
  switch (node.type) {
    case CompositeIsmNodeType.AGGREGATION:
      return node.subIsms.some((sub) => someCompositeIsmNode(sub, predicate));
    case CompositeIsmNodeType.AMOUNT_ROUTING:
      return (
        someCompositeIsmNode(node.lower, predicate) ||
        someCompositeIsmNode(node.upper, predicate)
      );
    case CompositeIsmNodeType.ROUTING:
    case CompositeIsmNodeType.FALLBACK_ROUTING:
      return node.domains
        ? Object.values(node.domains).some((domainNode) =>
            someCompositeIsmNode(domainNode, predicate),
          )
        : false;
    case CompositeIsmNodeType.TRUSTED_RELAYER:
    case CompositeIsmNodeType.MULTISIG_MESSAGE_ID:
    case CompositeIsmNodeType.TEST:
    case CompositeIsmNodeType.PAUSABLE:
    case CompositeIsmNodeType.RATE_LIMITED:
      return false;
    default:
      return assertNever(node, 'someCompositeIsmNode');
  }
}

function assertCompositeIsmNodeSupportedAsMailboxDefault(
  node: CompositeIsmNodeArtifactConfig,
  context: string,
): void {
  switch (node.type) {
    case CompositeIsmNodeType.AGGREGATION:
      for (const subIsm of node.subIsms) {
        assertCompositeIsmNodeSupportedAsMailboxDefault(subIsm, context);
      }
      return;
    case CompositeIsmNodeType.AMOUNT_ROUTING:
      assertCompositeIsmNodeSupportedAsMailboxDefault(node.lower, context);
      assertCompositeIsmNodeSupportedAsMailboxDefault(node.upper, context);
      return;
    case CompositeIsmNodeType.ROUTING:
    case CompositeIsmNodeType.FALLBACK_ROUTING:
      if (!node.domains) return;
      for (const domainIsm of Object.values(node.domains)) {
        assertCompositeIsmNodeSupportedAsMailboxDefault(domainIsm, context);
      }
      return;
    case CompositeIsmNodeType.RATE_LIMITED:
      assert(
        false,
        `A compositeIsm 'rateLimited' node is only supported on a warp route, but one was configured for ${context}. Remove the rateLimited node.`,
      );
    case CompositeIsmNodeType.TRUSTED_RELAYER:
    case CompositeIsmNodeType.MULTISIG_MESSAGE_ID:
    case CompositeIsmNodeType.TEST:
    case CompositeIsmNodeType.PAUSABLE:
      return;
    default:
      return assertNever(
        node,
        'assertCompositeIsmNodeSupportedAsMailboxDefault',
      );
  }
}

function assertIsmConfigSupportedAsMailboxDefault(
  config: IsmArtifactConfig,
  context: string,
): void {
  if (config.type === IsmType.RATE_LIMITED) {
    assert(
      false,
      `A rateLimitedIsm is only supported on a warp route, but one was configured for ${context}.`,
    );
  }

  if (config.type === IsmType.COMPOSITE) {
    assertCompositeIsmNodeSupportedAsMailboxDefault(config.root, context);
    return;
  }

  if (isDirectIsmArtifactConfig(config)) return;

  switch (config.type) {
    case IsmType.AGGREGATION:
    case IsmType.STORAGE_AGGREGATION:
      for (const module of config.modules) {
        if (!isArtifactUnderived(module)) {
          assertIsmConfigSupportedAsMailboxDefault(module.config, context);
        }
      }
      return;
    case IsmType.ROUTING:
    case IsmType.INCREMENTAL_ROUTING:
    case IsmType.FALLBACK_ROUTING:
      for (const domainIsm of Object.values(config.domains)) {
        if (!isArtifactUnderived(domainIsm)) {
          assertIsmConfigSupportedAsMailboxDefault(domainIsm.config, context);
        }
      }
      return;
    case IsmType.AMOUNT_ROUTING:
      for (const nestedIsm of [config.lowerIsm, config.upperIsm]) {
        if (!isArtifactUnderived(nestedIsm)) {
          assertIsmConfigSupportedAsMailboxDefault(nestedIsm.config, context);
        }
      }
      return;
    default:
      return assertNever(config, 'assertIsmConfigSupportedAsMailboxDefault');
  }
}

/**
 * Validates every expanded ISM and composite node before using an artifact as
 * a mailbox default ISM. UNDERIVED address references are intentionally opaque.
 *
 * A rate-limited node reads a transfer amount from a fixed offset of a warp
 * TokenMessage body, so it cannot safely validate arbitrary mailbox traffic.
 * Keep both recursive switches exhaustive so future ISM variants must declare
 * their mailbox compatibility before compiling.
 */
export function assertIsmSupportedAsMailboxDefault(
  artifact: Artifact<IsmArtifactConfig, DeployedIsmAddress>,
  context: string,
): void {
  if (isArtifactUnderived(artifact)) return;
  assertIsmConfigSupportedAsMailboxDefault(artifact.config, context);
}

function ismArtifactHasExplicitRateLimitedRecipient(
  config: IsmArtifactConfig,
): boolean {
  if (config.type === IsmType.RATE_LIMITED) {
    return !isNullish(config.recipient);
  }

  if (config.type === IsmType.COMPOSITE) {
    return someCompositeIsmNode(
      config.root,
      (node) =>
        node.type === CompositeIsmNodeType.RATE_LIMITED &&
        !isNullish(node.recipient),
    );
  }

  if (isDirectIsmArtifactConfig(config)) return false;

  switch (config.type) {
    case IsmType.AGGREGATION:
    case IsmType.STORAGE_AGGREGATION:
      return config.modules.some(
        (module) =>
          isArtifactNew(module) &&
          ismArtifactHasExplicitRateLimitedRecipient(module.config),
      );
    case IsmType.ROUTING:
    case IsmType.INCREMENTAL_ROUTING:
    case IsmType.FALLBACK_ROUTING:
      return Object.values(config.domains).some(
        (domainIsm) =>
          isArtifactNew(domainIsm) &&
          ismArtifactHasExplicitRateLimitedRecipient(domainIsm.config),
      );
    case IsmType.AMOUNT_ROUTING:
      return [config.lowerIsm, config.upperIsm].some(
        (nestedIsm) =>
          isArtifactNew(nestedIsm) &&
          ismArtifactHasExplicitRateLimitedRecipient(nestedIsm.config),
      );
    default:
      return assertNever(config, 'ismArtifactHasExplicitRateLimitedRecipient');
  }
}

/**
 * Rejects hand-written `rateLimited.recipient` values in the ISM artifacts
 * that a warp create will deploy. DEPLOYED descendants are references to
 * existing ISMs, so they are validated against the router after it exists.
 */
export function assertRateLimitedIsmRecipientsUnset(
  artifact: Artifact<IsmArtifactConfig, DeployedIsmAddress>,
  context: string,
): void {
  if (!isArtifactNew(artifact)) return;
  const hasRecipient = ismArtifactHasExplicitRateLimitedRecipient(
    artifact.config,
  );
  assert(
    !hasRecipient,
    `compositeIsm rateLimited.recipient must not be set when deploying a new warp route for ${context}: it is resolved to the router address being deployed. Remove the recipient field.`,
  );
}

const RECIPIENT_BYTES32_REGEX = /^0x[0-9a-fA-F]{64}$/;

/**
 * Validates and normalizes the protocol-independent address representation
 * stored in a Hyperlane message recipient field. Protocol backends must encode
 * native addresses before invoking contextual ISM resolution.
 */
function normalizeRecipientBytes32(address: string): string {
  assert(
    RECIPIENT_BYTES32_REGEX.test(address),
    `Expected a 32-byte Hyperlane address, got ${address}`,
  );
  return address.toLowerCase();
}

export interface ContextualAddress {
  readonly address: string;
  readonly toBytes32: () => string;
}

function assertCompositeIsmNodeRecipientMatches(
  node: CompositeIsmNodeArtifactConfig,
  warpRouter: ContextualAddress,
  context: string,
): void {
  switch (node.type) {
    case CompositeIsmNodeType.AGGREGATION:
      for (const subIsm of node.subIsms) {
        assertCompositeIsmNodeRecipientMatches(subIsm, warpRouter, context);
      }
      return;
    case CompositeIsmNodeType.AMOUNT_ROUTING:
      assertCompositeIsmNodeRecipientMatches(node.lower, warpRouter, context);
      assertCompositeIsmNodeRecipientMatches(node.upper, warpRouter, context);
      return;
    case CompositeIsmNodeType.ROUTING:
    case CompositeIsmNodeType.FALLBACK_ROUTING:
      if (!node.domains) return;
      for (const domainIsm of Object.values(node.domains)) {
        assertCompositeIsmNodeRecipientMatches(domainIsm, warpRouter, context);
      }
      return;
    case CompositeIsmNodeType.RATE_LIMITED: {
      const recipient = normalizeRecipientBytes32(warpRouter.toBytes32());
      assert(
        !isNullish(node.recipient),
        `Deployed compositeIsm rateLimited.recipient is missing for ${context}.`,
      );
      assert(
        normalizeRecipientBytes32(node.recipient) === recipient,
        `Deployed compositeIsm rateLimited.recipient ${node.recipient} does not match the warp router it protects (${recipient}) for ${context}.`,
      );
      return;
    }
    case CompositeIsmNodeType.TRUSTED_RELAYER:
    case CompositeIsmNodeType.MULTISIG_MESSAGE_ID:
    case CompositeIsmNodeType.TEST:
    case CompositeIsmNodeType.PAUSABLE:
      return;
    default:
      return assertNever(node, 'assertCompositeIsmNodeRecipientMatches');
  }
}

function assertIsmConfigRecipientsMatch(
  config: IsmArtifactConfig,
  warpRouter: ContextualAddress,
  context: string,
): void {
  if (config.type === IsmType.RATE_LIMITED) {
    const recipient = normalizeRecipientBytes32(warpRouter.toBytes32());
    assert(
      !isNullish(config.recipient),
      `Deployed rateLimitedIsm recipient is missing for ${context}.`,
    );
    assert(
      normalizeRecipientBytes32(config.recipient) === recipient,
      `Deployed rateLimitedIsm recipient ${config.recipient} does not match the warp router it protects (${recipient}) for ${context}.`,
    );
    return;
  }

  if (config.type === IsmType.COMPOSITE) {
    assertCompositeIsmNodeRecipientMatches(config.root, warpRouter, context);
    return;
  }

  if (isDirectIsmArtifactConfig(config)) return;

  switch (config.type) {
    case IsmType.AGGREGATION:
    case IsmType.STORAGE_AGGREGATION:
      for (const module of config.modules) {
        if (!isArtifactUnderived(module)) {
          assertIsmConfigRecipientsMatch(module.config, warpRouter, context);
        }
      }
      return;
    case IsmType.ROUTING:
    case IsmType.INCREMENTAL_ROUTING:
    case IsmType.FALLBACK_ROUTING:
      for (const domainIsm of Object.values(config.domains)) {
        if (!isArtifactUnderived(domainIsm)) {
          assertIsmConfigRecipientsMatch(domainIsm.config, warpRouter, context);
        }
      }
      return;
    case IsmType.AMOUNT_ROUTING:
      for (const nestedIsm of [config.lowerIsm, config.upperIsm]) {
        if (!isArtifactUnderived(nestedIsm)) {
          assertIsmConfigRecipientsMatch(nestedIsm.config, warpRouter, context);
        }
      }
      return;
    default:
      return assertNever(config, 'assertIsmConfigRecipientsMatch');
  }
}

function assertNoNewIsmDescendants(
  config: IsmArtifactConfig,
  context: string,
): void {
  if (isDirectIsmArtifactConfig(config)) return;

  switch (config.type) {
    case IsmType.AGGREGATION:
    case IsmType.STORAGE_AGGREGATION:
      for (const module of config.modules) {
        assert(
          !isArtifactNew(module),
          `A DEPLOYED ISM used while creating ${context} cannot contain a NEW aggregation module.`,
        );
        if (isArtifactDeployed(module))
          assertNoNewIsmDescendants(module.config, context);
      }
      return;
    case IsmType.ROUTING:
    case IsmType.INCREMENTAL_ROUTING:
    case IsmType.FALLBACK_ROUTING:
      for (const [domainId, domainIsm] of Object.entries(config.domains)) {
        assert(
          !isArtifactNew(domainIsm),
          `A DEPLOYED ISM used while creating ${context} cannot contain a NEW descendant for domain ${domainId}. Update the deployed ISM first, or configure the root ISM as NEW.`,
        );
        if (isArtifactDeployed(domainIsm)) {
          assertNoNewIsmDescendants(domainIsm.config, context);
        }
      }
      return;
    case IsmType.AMOUNT_ROUTING:
      for (const nestedIsm of [config.lowerIsm, config.upperIsm]) {
        assert(
          !isArtifactNew(nestedIsm),
          `A DEPLOYED ISM used while creating ${context} cannot contain a NEW amount routing descendant.`,
        );
        if (isArtifactDeployed(nestedIsm)) {
          assertNoNewIsmDescendants(nestedIsm.config, context);
        }
      }
      return;
    default:
      return assertNever(config, 'assertNoNewIsmDescendants');
  }
}

function resolveCompositeIsmNodeRecipients(
  node: CompositeIsmNodeArtifactConfig,
  recipient: string,
  context: string,
): CompositeIsmNodeArtifactConfig {
  switch (node.type) {
    case CompositeIsmNodeType.TRUSTED_RELAYER:
      return { type: node.type, relayer: node.relayer };
    case CompositeIsmNodeType.MULTISIG_MESSAGE_ID:
      return {
        type: node.type,
        validators: node.validators,
        threshold: node.threshold,
      };
    case CompositeIsmNodeType.TEST:
      return { type: node.type, accept: node.accept };
    case CompositeIsmNodeType.PAUSABLE:
      return { type: node.type, paused: node.paused };
    case CompositeIsmNodeType.AGGREGATION:
      return {
        type: node.type,
        threshold: node.threshold,
        subIsms: nonEmptyArray(
          node.subIsms.map((sub) =>
            resolveCompositeIsmNodeRecipients(sub, recipient, context),
          ),
        ),
      };
    case CompositeIsmNodeType.AMOUNT_ROUTING:
      return {
        type: node.type,
        threshold: node.threshold,
        lower: resolveCompositeIsmNodeRecipients(
          node.lower,
          recipient,
          context,
        ),
        upper: resolveCompositeIsmNodeRecipients(
          node.upper,
          recipient,
          context,
        ),
      };
    case CompositeIsmNodeType.RATE_LIMITED: {
      if (!isNullish(node.recipient)) {
        assert(
          normalizeRecipientBytes32(node.recipient) === recipient,
          `compositeIsm rateLimited.recipient ${node.recipient} does not match the warp router it protects (${recipient}) for ${context}. Remove the recipient field to have it resolved automatically.`,
        );
      }
      return {
        type: node.type,
        maxCapacity: node.maxCapacity,
        mailbox: node.mailbox,
        recipient,
      };
    }
    case CompositeIsmNodeType.ROUTING: {
      const domains = resolveCompositeIsmDomainRecipients(
        node.domains,
        recipient,
        context,
      );
      return {
        type: node.type,
        ...(domains ? { domains } : {}),
      };
    }
    case CompositeIsmNodeType.FALLBACK_ROUTING: {
      const domains = resolveCompositeIsmDomainRecipients(
        node.domains,
        recipient,
        context,
      );
      return {
        type: node.type,
        fallbackIsm: node.fallbackIsm,
        ...(domains ? { domains } : {}),
      };
    }
    default:
      return assertNever(node, 'resolveCompositeIsmNodeRecipients');
  }
}

function resolveCompositeIsmDomainRecipients(
  domains: Record<number, CompositeIsmNodeArtifactConfig> | undefined,
  recipient: string,
  context: string,
): Record<number, CompositeIsmNodeArtifactConfig> | undefined {
  if (!domains) return undefined;
  const resolved: Record<number, CompositeIsmNodeArtifactConfig> = {};
  for (const [domainIdStr, domainNode] of Object.entries(domains)) {
    resolved[Number(domainIdStr)] = resolveCompositeIsmNodeRecipients(
      domainNode,
      recipient,
      context,
    );
  }
  return resolved;
}

function resolveIsmArtifactRecipients(
  artifact: Artifact<IsmArtifactConfig, DeployedIsmAddress>,
  warpRouter: ContextualAddress,
  context: string,
): Artifact<IsmArtifactConfig, DeployedIsmAddress> {
  if (isArtifactUnderived(artifact)) return artifact;
  return {
    ...artifact,
    config: resolveRateLimitedIsmRecipients(
      artifact.config,
      warpRouter,
      context,
    ),
  };
}

function resolveNewIsmConfigRecipients(
  config: IsmArtifactConfig,
  warpRouter: ContextualAddress,
  context: string,
): IsmArtifactConfig {
  if (config.type !== IsmType.ROUTING) {
    return resolveRateLimitedIsmRecipients(config, warpRouter, context);
  }

  const domains: RoutingIsmArtifactConfig['domains'] = {};
  for (const [domainId, domainIsm] of Object.entries(config.domains)) {
    if (isArtifactUnderived(domainIsm)) {
      domains[Number(domainId)] = domainIsm;
    } else if (isArtifactDeployed(domainIsm)) {
      assertIsmConfigRecipientsMatch(domainIsm.config, warpRouter, context);
      domains[Number(domainId)] = domainIsm;
    } else if (isArtifactNew(domainIsm)) {
      domains[Number(domainId)] = {
        ...domainIsm,
        config: resolveNewIsmConfigRecipients(
          domainIsm.config,
          warpRouter,
          context,
        ),
      };
    } else {
      domains[Number(domainId)] = assertNever(
        domainIsm,
        'resolveNewIsmConfigRecipients',
      );
    }
  }
  return { type: config.type, owner: config.owner, domains };
}

export const IsmArtifactResolutionOperation = {
  CREATE: 'create',
  UPDATE: 'update',
} as const;

export type IsmArtifactResolutionOperation =
  (typeof IsmArtifactResolutionOperation)[keyof typeof IsmArtifactResolutionOperation];

export interface IsmArtifactResolutionContext {
  operation: IsmArtifactResolutionOperation;
  warpRouter: ContextualAddress;
  context: string;
}

/**
 * Resolves an ISM artifact using its surrounding deployment context. Creating
 * a parent artifact deploys only NEW descendants; DEPLOYED descendants are
 * validated and preserved as references. Updating a DEPLOYED parent may update
 * its expanded DEPLOYED descendants recursively.
 */
export function resolveIsmArtifact(
  artifact: ArtifactNew<IsmArtifactConfig> | DeployedIsmArtifact,
  resolutionContext: IsmArtifactResolutionContext,
): ArtifactNew<IsmArtifactConfig> | DeployedIsmArtifact {
  const { context, operation, warpRouter } = resolutionContext;
  if (isArtifactNew(artifact)) {
    return {
      ...artifact,
      config: resolveNewIsmConfigRecipients(
        artifact.config,
        warpRouter,
        context,
      ),
    };
  }
  if (operation === IsmArtifactResolutionOperation.CREATE) {
    assertNoNewIsmDescendants(artifact.config, context);
    assertIsmConfigRecipientsMatch(artifact.config, warpRouter, context);
    return artifact;
  }
  return {
    ...artifact,
    config: resolveRateLimitedIsmRecipients(
      artifact.config,
      warpRouter,
      context,
    ),
  };
}

/**
 * Fills in every unset `rateLimited.recipient` in a composite ISM tree with
 * the warp router the ISM protects, and rejects any hand-written recipient
 * that names a different address.
 *
 * The on-chain program requires a specific non-zero recipient
 * (rust/sealevel/programs/ism/composite-ism/src/processor.rs) but a wrong one
 * fails only at delivery time, indistinguishably from a rate-limit trip — so
 * the value is derived here rather than left to the config author.
 *
 * Compound ISM artifacts are traversed recursively. UNDERIVED children are
 * returned unchanged because an address-only artifact has no config to
 * resolve. The exhaustive switch ensures future compound artifact types must
 * declare their child traversal when they are added to IsmArtifactConfig.
 */
export function resolveRateLimitedIsmRecipients(
  config: IsmArtifactConfig,
  warpRouter: ContextualAddress,
  context: string,
): IsmArtifactConfig {
  if (config.type === IsmType.RATE_LIMITED) {
    const recipient = normalizeRecipientBytes32(warpRouter.toBytes32());
    if (!isNullish(config.recipient)) {
      assert(
        normalizeRecipientBytes32(config.recipient) === recipient,
        `rateLimitedIsm recipient ${config.recipient} does not match the warp router it protects (${recipient}) for ${context}. Remove the recipient field to have it resolved automatically.`,
      );
    }
    return {
      type: config.type,
      maxCapacity: config.maxCapacity,
      duration: config.duration,
      recipient,
      owner: config.owner,
    };
  }

  if (config.type === IsmType.COMPOSITE) {
    const recipient = normalizeRecipientBytes32(warpRouter.toBytes32());
    return {
      type: config.type,
      owner: config.owner,
      root: resolveCompositeIsmNodeRecipients(config.root, recipient, context),
    };
  }

  if (isDirectIsmArtifactConfig(config)) return config;

  switch (config.type) {
    case IsmType.AGGREGATION:
    case IsmType.STORAGE_AGGREGATION:
      return {
        type: config.type,
        threshold: config.threshold,
        modules: nonEmptyArray(
          config.modules.map((module) =>
            resolveIsmArtifactRecipients(module, warpRouter, context),
          ),
        ),
      };
    case IsmType.ROUTING:
    case IsmType.INCREMENTAL_ROUTING:
    case IsmType.FALLBACK_ROUTING: {
      const domains: typeof config.domains = {};
      for (const [domainId, domainIsm] of Object.entries(config.domains)) {
        domains[Number(domainId)] = resolveIsmArtifactRecipients(
          domainIsm,
          warpRouter,
          context,
        );
      }
      return {
        type: config.type,
        owner: config.owner,
        domains,
      };
    }
    case IsmType.AMOUNT_ROUTING:
      return {
        type: config.type,
        threshold: config.threshold,
        lowerIsm: resolveIsmArtifactRecipients(
          config.lowerIsm,
          warpRouter,
          context,
        ),
        upperIsm: resolveIsmArtifactRecipients(
          config.upperIsm,
          warpRouter,
          context,
        ),
      };
    default:
      return assertNever(config, 'resolveRateLimitedIsmRecipients');
  }
}

export function ismArtifactToDerivedConfig(
  artifact: DeployedIsmArtifact,
  chainLookup: ChainLookup,
): DerivedIsmConfig {
  const config = artifact.config;
  const address = artifact.deployed.address;

  if (!isLegacyIsmArtifactConfig(config)) {
    return throwUnhandledIsmType(config, 'ismArtifactToDerivedConfig');
  }

  switch (config.type) {
    case IsmType.AGGREGATION:
      return {
        type: config.type,
        threshold: config.threshold,
        address,
        modules: nonEmptyArray(
          config.modules.map((module) => {
            if (isArtifactDeployed(module))
              return ismArtifactToDerivedConfig(module, chainLookup);
            assert(
              isArtifactUnderived(module),
              'Cannot convert aggregation ISM to derived config: nested ISM is NEW and has no address',
            );
            return module.deployed.address;
          }),
        ),
      };
    case IsmType.ROUTING: {
      // For routing ISMs, convert domain IDs back to chain names
      // and convert nested artifacts to IsmConfig or address strings
      const domains: Record<string, IsmConfig | string> = {};

      for (const [domainIdStr, domainArtifact] of Object.entries(
        config.domains,
      )) {
        const domainId = parseInt(domainIdStr);
        const chainName = chainLookup.getChainName(domainId);
        if (!chainName) {
          // Skip unknown domains
          continue;
        }

        if (isArtifactDeployed(domainArtifact)) {
          // Recursively convert nested ISM artifacts
          domains[chainName] = ismArtifactToDerivedConfig(
            domainArtifact,
            chainLookup,
          );
        } else if (isArtifactUnderived(domainArtifact)) {
          // Use the address string for underived artifacts
          domains[chainName] = domainArtifact.deployed.address;
        } else if (isArtifactNew(domainArtifact)) {
          throw new Error(
            `Cannot convert routing ISM to derived config: nested ISM for domain ${chainName} (${domainId}) is NEW and has no address`,
          );
        }
      }

      return {
        type: IsmType.ROUTING,
        owner: config.owner,
        domains,
        address,
      };
    }

    case IsmType.MERKLE_ROOT_MULTISIG:
    case IsmType.MESSAGE_ID_MULTISIG:
      // Multisig ISMs have identical structure between Artifact and Config APIs
      return {
        ...config,
        address,
      };

    case IsmType.PAUSABLE:
    case IsmType.TEST_ISM:
      // Test ISMs have identical structure between Artifact and Config APIs
      return {
        ...config,
        address,
      };

    case IsmType.COMPOSITE:
      return {
        type: IsmType.COMPOSITE,
        owner: config.owner,
        root: compositeIsmNodeArtifactToConfig(config.root, chainLookup),
        address,
      };

    default: {
      return assertNever(config, 'ismArtifactToDerivedConfig');
    }
  }
}

/**
 * Converts IsmConfig (Config API) to IsmArtifactConfig (Artifact API).
 *
 * Key transformations:
 * - String chain names → numeric domain IDs (for routing ISM domains)
 * - Address string references → ArtifactUnderived objects
 * - Recursively handles nested routing ISM configurations
 * - Other ISM types (multisig, testIsm) pass through unchanged
 *
 * @param config The ISM configuration using Config API format
 * @param chainLookup Chain lookup interface for resolving chain names to domain IDs
 * @returns Artifact wrapper around IsmArtifactConfig suitable for artifact writers
 *
 * @example
 * ```typescript
 * // Config API format
 * const ismConfig: IsmConfig = {
 *   type: 'domainRoutingIsm',
 *   owner: '0x123...',
 *   domains: {
 *     ethereum: { type: 'merkleRootMultisigIsm', validators: [...], threshold: 2 },
 *     polygon: '0xabc...' // address reference
 *   }
 * };
 *
 * // Convert to Artifact API format
 * const artifact = ismConfigToArtifact(ismConfig, chainLookup);
 * // artifact.config.domains is now Record<number, Artifact<IsmArtifactConfig>>
 * // with numeric domain IDs and properly wrapped nested configs
 * ```
 */
export function ismConfigToArtifact(
  config: IsmConfig,
  chainLookup: ChainLookup,
): ArtifactNew<IsmArtifactConfig> {
  if (config.type === IsmType.AGGREGATION) {
    return {
      artifactState: ArtifactState.NEW,
      config: {
        type: config.type,
        threshold: config.threshold,
        modules: nonEmptyArray(
          config.modules.map((module) =>
            typeof module === 'string'
              ? {
                  artifactState: ArtifactState.UNDERIVED,
                  deployed: { address: module },
                }
              : ismConfigToArtifact(module, chainLookup),
          ),
        ),
      },
    };
  }

  // Handle routing ISMs - need to convert chain names to domain IDs
  if (config.type === IsmType.ROUTING) {
    const domains: Record<
      number,
      Artifact<IsmArtifactConfig, DeployedIsmAddress>
    > = {};

    for (const [chainName, nestedConfig] of Object.entries(config.domains)) {
      const domainId = chainLookup.getDomainId(chainName);
      if (isNullish(domainId)) {
        // Skip unknown chains - they'll be warned about during deployment
        continue;
      }

      if (typeof nestedConfig === 'string') {
        // Address reference - create an UNDERIVED artifact
        // This represents a predeployed ISM with unspecified type
        // The routing ISM writer will pass it through without reading
        // Only readers will fetch its config from chain if needed
        domains[domainId] = {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: nestedConfig },
        };
      } else {
        // Nested ISM config - recursively convert
        domains[domainId] = ismConfigToArtifact(nestedConfig, chainLookup);
      }
    }

    return {
      artifactState: ArtifactState.NEW,
      config: {
        type: IsmType.ROUTING,
        owner: config.owner,
        domains,
      },
    };
  }

  // Composite ISM - need to convert chain names to domain IDs throughout the tree
  if (config.type === IsmType.COMPOSITE) {
    return {
      artifactState: ArtifactState.NEW,
      config: {
        type: IsmType.COMPOSITE,
        owner: config.owner,
        root: compositeIsmNodeConfigToArtifact(config.root, chainLookup),
      },
    };
  }

  switch (config.type) {
    case IsmType.MERKLE_ROOT_MULTISIG:
    case IsmType.MESSAGE_ID_MULTISIG:
    case IsmType.PAUSABLE:
    case IsmType.TEST_ISM:
      return { artifactState: ArtifactState.NEW, config };
    default:
      return assertNever(config, 'ismConfigToArtifact');
  }
}
