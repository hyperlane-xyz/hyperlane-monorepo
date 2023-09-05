import {
  AgentChainMetadata,
  AgentSignerAwsKey,
  AgentSignerKeyType,
  ChainName,
  RpcConsensusType,
} from '@hyperlane-xyz/sdk';

import { Contexts } from '../../../config/contexts';
import { AgentChainNames, Role } from '../../roles';
import { DeployEnvironment } from '../environment';
import { HelmImageValues } from '../infrastructure';

import {
  BaseRelayerConfig,
  HelmRelayerChainValues,
  HelmRelayerValues,
} from './relayer';
import { BaseScraperConfig, HelmScraperValues } from './scraper';
import { HelmValidatorValues, ValidatorBaseChainConfigMap } from './validator';

export type DeepPartial<T> = T extends object
  ? {
      [P in keyof T]?: DeepPartial<T[P]>;
    }
  : T;

// See rust/helm/values.yaml for the full list of options and their defaults.
// This is the root object in the values file.
export interface HelmRootAgentValues {
  image: HelmImageValues;
  hyperlane: HelmHyperlaneValues;
  nameOverride?: string;
}

// See rust/helm/values.yaml for the full list of options and their defaults.
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

// See rust/helm/values.yaml for the full list of options and their defaults.
// This is at `.hyperlane.chains` in the values file.
export interface HelmAgentChainOverride
  extends DeepPartial<AgentChainMetadata> {
  name: AgentChainMetadata['name'];
  disabled?: boolean;
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
}

// incomplete common agent configuration for a role
interface AgentRoleConfig {
  docker: DockerConfig;
  chainDockerOverrides?: Record<ChainName, Partial<DockerConfig>>;
  rpcConsensusType: RpcConsensusType;
  index?: IndexingConfig;
}

// require specifying that it's the "aws" type for helm
export type AwsKeyConfig = Required<AgentSignerAwsKey>;
// only require specifying that it's the "hex" type for helm since the hex key will be pulled from secrets.
export type HexKeyConfig = { type: AgentSignerKeyType.Hex };
export type KeyConfig = AwsKeyConfig | HexKeyConfig;

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

export abstract class AgentConfigHelper<R = unknown>
  extends RootAgentConfigHelper
  implements AgentRoleConfig
{
  rpcConsensusType: RpcConsensusType;
  docker: DockerConfig;
  chainDockerOverrides?: Record<ChainName, Partial<DockerConfig>>;
  index?: IndexingConfig;

  protected constructor(root: RootAgentConfig, agent: AgentRoleConfig) {
    super(root);
    this.rpcConsensusType = agent.rpcConsensusType;
    this.docker = agent.docker;
    this.chainDockerOverrides = agent.chainDockerOverrides;
    this.index = agent.index;
  }

  // role this config is for
  abstract get role(): Role;

  abstract buildConfig(): Promise<R>;

  // If the provided chain has an override, return the override, otherwise return the default.
  dockerImageForChain(chainName: ChainName): DockerConfig {
    if (this.chainDockerOverrides?.[chainName]) {
      return {
        ...this.docker,
        ...this.chainDockerOverrides[chainName],
      };
    }
    return this.docker;
  }
}

export const allAgentChainNames = (agentChainNames: AgentChainNames) => [
  ...new Set(Object.values(agentChainNames).reduce((a, b) => a.concat(b), [])),
];
