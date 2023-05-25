// Eventually consumed by Rust, which expects camelCase values
import {
  AgentChainSetup,
  AgentConnection,
  AgentConnectionType,
  ChainName,
} from '@hyperlane-xyz/sdk';

import { Contexts } from '../../../config/contexts';
import { KEY_ROLE_ENUM } from '../../agents/roles';
import { DeployEnvironment } from '../environment';
import { HelmImageValues } from '../infrastructure';

import {
  BaseRelayerConfig,
  HelmRelayerChainValues,
  HelmRelayerValues,
} from './relayer';
import { BaseScraperConfig, HelmScraperValues } from './scraper';
import { HelmValidatorValues, ValidatorBaseChainConfigMap } from './validator';

export {
  ValidatorConfigHelper,
  CheckpointSyncerType,
  ValidatorBaseChainConfigMap,
} from './validator';
export {
  RelayerConfigHelper,
  GasPaymentEnforcementPolicyType,
  routerMatchingList,
} from './relayer';
export { ScraperConfigHelper } from './scraper';

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

export interface AgentConfig extends BaseAgentConfig {
  relayer?: WithOverrideableBase<BaseRelayerConfig>;
  validators?: WithOverrideableBase<ValidatorBaseChainConfigMap>;
  scraper?: WithOverrideableBase<BaseScraperConfig>;
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
  rolesWithKeys: KEY_ROLE_ENUM[];
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

export type WithOverrideableBase<T> = T & {
  baseOverride?: Partial<BaseAgentConfig>;
};

// helper to deal with the broken TS type system that does not handle
// `{...config, baseOverride: { key: value } }` properly.
export function overrideBase<T>(
  config: T,
  baseOverride: Partial<BaseAgentConfig>,
): WithOverrideableBase<T> {
  return {
    ...config,
    baseOverride,
  };
}

// Helper interface to build configs. Ensures all helpers have a similar interface.
export interface ConfigHelper<T> {
  readonly isDefined: boolean;

  buildConfig(): Promise<T | undefined>;
}

export abstract class AgentConfigHelper implements BaseAgentConfig {
  aws?: AwsConfig;
  connectionType: AgentConnectionType;
  context: Contexts;
  contextChainNames: ChainName[];
  docker: DockerConfig;
  environmentChainNames: ChainName[];
  index?: IndexingConfig;
  namespace: string;
  rolesWithKeys: KEY_ROLE_ENUM[];
  runEnv: DeployEnvironment;

  protected constructor(
    config: AgentConfig,
    override: WithOverrideableBase<unknown> = {},
  ) {
    const merged: BaseAgentConfig = { ...config, ...override.baseOverride };
    this.aws = merged.aws;
    this.connectionType = merged.connectionType;
    this.context = merged.context;
    this.contextChainNames = merged.contextChainNames;
    this.docker = merged.docker;
    this.environmentChainNames = merged.environmentChainNames;
    this.index = merged.index;
    this.namespace = merged.namespace;
    this.rolesWithKeys = merged.rolesWithKeys;
    this.runEnv = merged.runEnv;
  }
}
