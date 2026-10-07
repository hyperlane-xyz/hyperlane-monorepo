import type { ChainAddresses } from '@hyperlane-xyz/registry';
import type {
  AnnotatedEV5Transaction,
  ChainMap,
  ChainName,
  ContractVerificationInput,
  ContractVerifier,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import type { Address, Logger } from '@hyperlane-xyz/utils';

import type { Modules } from '../../scripts/agent-utils.js';
import type { DeployEnvironment } from '../config/deploy-environment.js';

import type { ExportStore } from './address-export.js';

export const UpgradePhase = {
  Shadow: 'shadow',
  Prod: 'prod',
} as const;
export type UpgradePhase = (typeof UpgradePhase)[keyof typeof UpgradePhase];

export const SkipReason = {
  NonEvm: 'non-evm',
  Tron: 'tron',
  ZkSyncStack: 'zksync-stack',
  LegacyCoreHookRecovery: 'legacy-core-hook-recovery',
  ChainsToSkip: 'chains-to-skip',
  NoRegistryFactory: 'no-registry-factory',
  NoMailbox: 'no-mailbox',
  DefaultHookNotFallbackRouting: 'default-hook-not-fallback-routing',
  NoAggregationRoutes: 'no-aggregation-routes',
} as const;
export type SkipReason = (typeof SkipReason)[keyof typeof SkipReason];

export const ChainOutcome = {
  Skipped: 'skipped',
  UpToDate: 'up-to-date',
  Planned: 'planned',
  Applied: 'applied',
  Emitted: 'emitted',
  Error: 'error',
} as const;
export type ChainOutcome = (typeof ChainOutcome)[keyof typeof ChainOutcome];

export interface ChainDomain {
  chain: ChainName;
  domainId: number;
}

export interface RouteConfig {
  destination: number;
  hook: Address;
}

export interface AggregatorInfo {
  address: Address;
  children: Address[];
  version: string;
}

export const HookClassificationKind = {
  Aggregation: 'aggregation',
  Other: 'other',
  Unknown: 'unknown',
} as const;

export type HookClassification =
  | {
      kind: typeof HookClassificationKind.Aggregation;
      aggregator: AggregatorInfo;
    }
  | { kind: typeof HookClassificationKind.Other; hookType: number }
  | { kind: typeof HookClassificationKind.Unknown };

export interface MappedRoute {
  domain: ChainDomain;
  hook: Address;
}

export interface IgnoredDomainCounts {
  mapped: number;
  legacyAggregator: number;
}

export interface ChainState {
  chain: ChainName;
  mailbox: Address;
  routingHook: Address;
  routingOwner: Address;
  routingFallback: Address;
  factory: { address: Address; version: string };
  routes: MappedRoute[];
  unmapped: ChainDomain[];
  classifications: Map<string, HookClassification>;
  ignored: IgnoredDomainCounts;
  registryAggregationHook?: AggregatorInfo;
}

export interface AggregatorSet {
  key: string;
  children: Address[];
  replaces: Address[];
}

export interface PlannedRoute {
  domain: ChainDomain;
  from: Address;
  key: string;
}

export interface NonAggregationRoute {
  domain: ChainDomain;
  hook: Address;
  hookType?: number;
}

export interface ChainPlan {
  needsFactory: boolean;
  sets: AggregatorSet[];
  migrations: PlannedRoute[];
  registryAggregationKey?: string;
  fixedRoutes: number;
  nonAggregation: NonAggregationRoute[];
  unmapped: ChainDomain[];
  upToDate: boolean;
}

export interface DomainCoverage {
  universe: number;
  mapped: number;
  fixed: number;
  legacy: number;
  unmapped: ChainName[];
  nonAggregation: Array<{ chain: ChainName; hook: Address }>;
  ignoredMapped: number;
  ignoredLegacy: number;
}

export interface AggregatorResult {
  children: Address[];
  replaces: Address[];
  address?: Address;
  deployed: boolean;
}

export interface ChainResult {
  chain: ChainName;
  outcome: ChainOutcome;
  skipReason?: SkipReason;
  detail?: string;
  owner?: Address;
  ownerType?: string;
  factory?: { address?: Address; previous?: Address; deployed: boolean };
  aggregators: AggregatorResult[];
  shadowRoutingHook?: Address;
  coverage?: DomainCoverage;
  setHooks?: { migrate: number; sent: number; emitted: number };
  txFile?: string;
  verificationRecoveryFiles: string[];
  registryKeysWritten: string[];
  pending: string[];
}

export interface UpgradePersistence {
  writeRegistryAddresses(chain: ChainName, addresses: ChainAddresses): void;
  writeVerificationInputs(
    module: Modules,
    inputs: ChainMap<ContractVerificationInput[]>,
  ): Promise<void>;
  writeVerificationRecovery(
    module: Modules,
    chain: ChainName,
    inputs: ContractVerificationInput[],
  ): Promise<string>;
  writeTransactions(
    chain: ChainName,
    txs: AnnotatedEV5Transaction[],
  ): Promise<string>;
  exportStore: ExportStore;
}

export interface SkipLists {
  legacyCoreHookRecoveryChains: ChainName[];
  chainsToSkip: ChainName[];
}

export interface UpgradeContext {
  environment: DeployEnvironment;
  phase: UpgradePhase;
  apply: boolean;
  multiProvider: MultiProvider;
  chainAddresses: ChainMap<ChainAddresses>;
  supportedDomains: ChainDomain[];
  registryDomainIds: number[];
  skipLists: SkipLists;
  contractVerifier?: ContractVerifier;
  persist: UpgradePersistence;
  concurrency: number;
  probeConcurrency: number;
  logger: Logger;
  now: () => string;
}
