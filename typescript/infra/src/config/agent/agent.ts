import {
  AgentChainMetadata,
  AgentSealevelPriorityFeeOracle,
  AgentSealevelTransactionSubmitter,
  AgentSignerAwsKey,
  AgentSignerKeyType,
  ChainName,
  RpcConsensusType,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, objMap } from '@hyperlane-xyz/utils';

import { Contexts } from '../../../config/contexts.js';
import { getChain } from '../../../config/registry.js';
import { AgentChainNames, AgentRole, Role } from '../../roles.js';
import { DeployEnvironment } from '../environment.js';
import { HelmImageValues } from '../infrastructure.js';

import {
  BaseRelayerConfig,
  HelmRelayerChainValues,
  HelmRelayerValues,
} from './relayer.js';
import { BaseScraperConfig, HelmScraperValues } from './scraper.js';
import {
  HelmValidatorValues,
  ValidatorBaseChainConfigMap,
} from './validator.js';

export type DeepPartial<T> = T extends object
  ? {
      [P in keyof T]?: DeepPartial<T[P]>;
    }
  : T;

// See rust/main/helm/values.yaml for the full list of options and their defaults.
// This is the root object in the values file.
export interface HelmRootAgentValues {
  image: HelmImageValues;
  hyperlane: HelmHyperlaneValues;
  nameOverride?: string;
  tolerations?: KubernetesToleration[];
}

// See rust/main/helm/values.yaml for the full list of options and their defaults.
// This is at `.hyperlane` in the values file.
interface HelmHyperlaneValues {
  runEnv: DeployEnvironment;
  context: Contexts;
  dbPath?: string;
  rustBacktrace?: '1' | 'full';
  aws: boolean;
  // chain overrides
  chains: HelmAgentChainOverride[];
  validator?: HelmValidatorValues;
  relayer?: HelmRelayerValues;
  relayerChains?: HelmRelayerChainValues[];
  scraper?: HelmScraperValues;
}

// See rust/main/helm/values.yaml for the full list of options and their defaults.
// This is at `.hyperlane.chains` in the values file.
export interface HelmAgentChainOverride
  extends DeepPartial<AgentChainMetadata> {
  name: AgentChainMetadata['name'];
}

export interface RootAgentConfig extends AgentContextConfig {
  // other is used by non-agent specific configuration (e.g. key-funder)
  relayer?: AgentRoleConfig & BaseRelayerConfig;
  validators?: AgentRoleConfig & {
    chains: ValidatorBaseChainConfigMap;
  };
  scraper?: AgentRoleConfig & BaseScraperConfig;
}

interface AgentEnvConfig {
  runEnv: DeployEnvironment;
  // Names of all chains in the environment
  environmentChainNames: ChainName[];
}

export interface AgentContextConfig extends AgentEnvConfig {
  namespace: string;
  context: Contexts;
  aws?: AwsConfig;
  // Roles to manage keys for
  rolesWithKeys: Role[];
  // Names of chains this context cares about (subset of environmentChainNames)
  contextChainNames: AgentChainNames;
  sealevel?: SealevelAgentConfig;
}

export interface SealevelAgentConfig {
  priorityFeeOracleConfigGetter?: (
    chain: ChainName,
  ) => AgentSealevelPriorityFeeOracle;
  transactionSubmitterConfigGetter?: (
    chain: ChainName,
  ) => AgentSealevelTransactionSubmitter;
}

// An ugly way to mark a URL as a the secret Helius URL when Helm templating
export const HELIUS_SECRET_URL_MARKER = 'helius';

// incomplete common agent configuration for a role
interface AgentRoleConfig {
  // K8s-specific
  docker: DockerConfig;
  chainDockerOverrides?: Record<ChainName, Partial<DockerConfig>>;
  resources?: KubernetesResources;

  // Agent-specific
  rpcConsensusType: RpcConsensusType;
  index?: IndexingConfig;
}

// require specifying that it's the "aws" type for helm
export type AwsKeyConfig = Required<AgentSignerAwsKey>;
// only require specifying that it's the "hex" type for helm since the hex key will be pulled from secrets.
export type HexKeyConfig = { type: AgentSignerKeyType.Hex };
export type CosmosKeyConfig = {
  type: AgentSignerKeyType.Cosmos;
  prefix: string;
};
// Starknet uses account abstraction, these contacts are either legacy or not.
export type StarknetKeyConfig = {
  type: AgentSignerKeyType.Starknet;
};
export type KeyConfig =
  | AwsKeyConfig
  | HexKeyConfig
  | CosmosKeyConfig
  | StarknetKeyConfig;
interface IndexingConfig {
  from: number;
  chunk: number;
}

export interface AwsConfig {
  region: string;
}

export interface DockerConfig {
  repo: string;
  tag: string;
}

export interface KubernetesResources {
  requests?: KubernetesComputeResources;
  limits?: KubernetesComputeResources;
}

export interface KubernetesComputeResources {
  cpu: string;
  memory: string;
}

export interface KubernetesToleration {
  key: string;
  operator: string;
  value: string;
  effect: string;
}

export class RootAgentConfigHelper implements AgentContextConfig {
  readonly rawConfig: RootAgentConfig;

  context: Contexts;
  namespace: string;
  runEnv: DeployEnvironment;
  aws?: AwsConfig;
  rolesWithKeys: Role[];
  contextChainNames: AgentChainNames;
  environmentChainNames: ChainName[];

  constructor(root: RootAgentConfig) {
    this.rawConfig = root;
    this.context = root.context;
    this.namespace = root.namespace;
    this.aws = root.aws;
    this.runEnv = root.runEnv;
    this.rolesWithKeys = root.rolesWithKeys;
    this.contextChainNames = root.contextChainNames;
    this.environmentChainNames = root.environmentChainNames;
  }

  get validatorDefined(): boolean {
    return !!this.rawConfig.validators;
  }

  get relayerDefined(): boolean {
    return !!this.rawConfig.relayer;
  }

  get scraperDefined(): boolean {
    return !!this.rawConfig.scraper;
  }
}

export abstract class AgentConfigHelper<
  R = unknown,
> extends RootAgentConfigHelper {
  protected constructor(
    root: RootAgentConfig,
    readonly agentRoleConfig: AgentRoleConfig,
  ) {
    super(root);
  }

  // role this config is for
  abstract get role(): Role;

  abstract buildConfig(): Promise<R>;

  // If the provided chain has an override, return the override, otherwise return the default.
  dockerImageForChain(chainName: ChainName): DockerConfig {
    if (this.agentRoleConfig.chainDockerOverrides?.[chainName]) {
      return {
        ...this.agentRoleConfig.docker,
        ...this.agentRoleConfig.chainDockerOverrides[chainName],
      };
    }
    return this.agentRoleConfig.docker;
  }
}

export const allAgentChainNames = (agentChainNames: AgentChainNames) => [
  ...new Set(Object.values(agentChainNames).reduce((a, b) => a.concat(b), [])),
];

// Returns the default KeyConfig for the `chainName`'s chain signer.
// For Ethereum or Sealevel, this is a hexKey, for Cosmos, this is a cosmosKey.
export function defaultChainSignerKeyConfig(chainName: ChainName): KeyConfig {
  const metadata = getChain(chainName);

  switch (metadata?.protocol) {
    case ProtocolType.Cosmos:
    case ProtocolType.CosmosNative:
      if (metadata.bech32Prefix === undefined) {
        throw new Error(
          `Bech32 prefix for cosmos chain ${chainName} is undefined`,
        );
      }
      return { type: AgentSignerKeyType.Cosmos, prefix: metadata.bech32Prefix };
    // Use starknet key for starknet & paradexsepolia
    case ProtocolType.Starknet: {
      return { type: AgentSignerKeyType.Starknet };
    }
    // For Ethereum and Sealevel use a hex key
    case ProtocolType.Ethereum:
    case ProtocolType.Sealevel:
    default:
      return { type: AgentSignerKeyType.Hex };
  }
}

export type AgentChainConfig<SupportedChains extends readonly ChainName[]> =
  Record<AgentRole, Record<SupportedChains[number], boolean>>;

/// Converts an AgentChainConfig to an AgentChainNames object.
export function getAgentChainNamesFromConfig<
  SupportedChains extends readonly ChainName[],
>(
  config: AgentChainConfig<SupportedChains>,
  supportedChainNames: SupportedChains,
): AgentChainNames {
  ensureAgentChainConfigIncludesAllChainNames(config, supportedChainNames);

  return objMap(config, (_, roleConfig) =>
    Object.entries(roleConfig)
      .filter(([_chain, enabled]) => enabled)
      .map(([chain]) => chain),
  );
}

// Throws if any of the roles in the config do not have all the expected chain names.
export function ensureAgentChainConfigIncludesAllChainNames<
  SupportedChains extends readonly ChainName[],
>(
  config: AgentChainConfig<SupportedChains>,
  expectedChainNames: SupportedChains,
) {
  for (const [role, roleConfig] of Object.entries(config)) {
    const chainNames = Object.keys(roleConfig);
    const missingChainNames = expectedChainNames.filter(
      (chainName) => !chainNames.includes(chainName),
    );
    const unknownChainNames = chainNames.filter(
      (chainName) => !expectedChainNames.includes(chainName),
    );

    if (missingChainNames.length > 0 || unknownChainNames.length > 0) {
      throw new Error(
        `${role} agent chain config incorrect. Missing chain names: ${missingChainNames}, unknown chain names: ${unknownChainNames}`,
      );
    }
  }
}
