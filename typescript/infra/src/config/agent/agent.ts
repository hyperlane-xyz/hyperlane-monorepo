import {
  AgentChainSetup,
  AgentConnection,
  AgentConnectionType,
  ChainName,
} from '@hyperlane-xyz/sdk';

import { Contexts } from '../../../config/contexts';
import { Role } from '../../roles';
import { DeployEnvironment } from '../environment';
import { HelmImageValues } from '../infrastructure';

import {
  BaseRelayerConfig,
  HelmRelayerChainValues,
  HelmRelayerValues,
} from './relayer';
import { BaseScraperConfig, HelmScraperValues } from './scraper';
import { HelmValidatorValues, ValidatorBaseChainConfigMap } from './validator';

// See rust/helm/values.yaml for the full list of options and their defaults.
// This is the root object in the values file.
export interface HelmRootAgentValues {
  image: HelmImageValues;
  hyperlane: HelmHyperlaneValues;
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
  extends Partial<Omit<AgentChainSetup, 'connection'>> {
  name: ChainName;
  disabled?: boolean;
  connection?: Partial<AgentConnection>;
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
  contextChainNames: ChainName[];
}

// incomplete common agent configuration for a role
interface AgentRoleConfig {
  docker: DockerConfig;
  quorumProvider?: boolean;
  connectionType: AgentConnectionType;
  index?: IndexingConfig;
}

export enum KeyType {
  Aws = 'aws',
  Hex = 'hexKey',
}

export interface AwsKeyConfig {
  type: KeyType.Aws;
  // ID of the key, can be an alias of the form `alias/foo-bar`
  id: string;
  // AWS region where the key is
  region: string;
}

// The private key is omitted so it can be fetched using external-secrets
export interface HexKeyConfig {
  type: KeyType.Hex;
}

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
  contextChainNames: ChainName[];
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
  connectionType: AgentConnectionType;
  docker: DockerConfig;
  index?: IndexingConfig;

  protected constructor(root: RootAgentConfig, agent: AgentRoleConfig) {
    super(root);
    this.connectionType = agent.connectionType;
    this.docker = agent.docker;
    this.index = agent.index;
  }

  // role this config is for
  abstract get role(): Role;

  abstract buildConfig(): Promise<R>;
}
