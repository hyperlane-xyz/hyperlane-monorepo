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

export interface AgentConfig {
  // other is used by non-agent specific configuration (e.g. key-funder)
  other: BaseAgentConfig;
  relayer?: BaseAgentConfig & BaseRelayerConfig;
  validators?: BaseAgentConfig & {
    chains: ValidatorBaseChainConfigMap;
  };
  scraper?: BaseAgentConfig & BaseScraperConfig;
}

// incomplete common agent configuration
export interface BaseAgentConfig {
  runEnv: DeployEnvironment;
  namespace: string;
  context: Contexts;
  docker: DockerConfig;
  quorumProvider?: boolean;
  connectionType: AgentConnectionType;
  index?: IndexingConfig;
  aws?: AwsConfig;
  // Names of all chains in the environment
  environmentChainNames: ChainName[];
  // Names of chains this context cares about
  contextChainNames: ChainName[];

  // Roles to manage keys for
  rolesWithKeys: Role[];
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

export abstract class AgentConfigHelper<R = unknown>
  implements BaseAgentConfig
{
  readonly rawConfig: AgentConfig;

  aws?: AwsConfig;
  connectionType: AgentConnectionType;
  context: Contexts;
  contextChainNames: ChainName[];
  docker: DockerConfig;
  environmentChainNames: ChainName[];
  index?: IndexingConfig;
  namespace: string;
  rolesWithKeys: Role[];
  runEnv: DeployEnvironment;

  protected constructor(root: AgentConfig, agent: BaseAgentConfig) {
    this.rawConfig = root;
    this.aws = agent.aws;
    this.connectionType = agent.connectionType;
    this.context = agent.context;
    this.contextChainNames = agent.contextChainNames;
    this.docker = agent.docker;
    this.environmentChainNames = agent.environmentChainNames;
    this.index = agent.index;
    this.namespace = agent.namespace;
    this.rolesWithKeys = agent.rolesWithKeys;
    this.runEnv = agent.runEnv;
  }

  abstract buildConfig(): Promise<R>;
}
