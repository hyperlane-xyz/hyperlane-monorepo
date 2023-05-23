import { BigNumberish } from 'ethers';

import { AgentConnectionType, ChainMap, ChainName } from '@hyperlane-xyz/sdk';

import { Contexts } from '../../config/contexts';
import { AgentAwsUser, ValidatorAgentAwsUser } from '../agents/aws';
import { KEY_ROLE_ENUM } from '../agents/roles';

import { DeployEnvironment } from './environment';

// // Allows a "default" config to be specified and any per-chain overrides.
// interface ChainOverridableConfig<T> {
//   default: T;
//   chainOverrides?: ChainMap<Partial<T>>;
// }
//
// // Returns the default config with any overridden values specified for the provided chain.
// function getChainOverriddenConfig<T>(
//   overridableConfig: ChainOverridableConfig<T>,
//   chain: ChainName,
// ): T {
//   return {
//     ...overridableConfig.default,
//     ...overridableConfig.chainOverrides?.[chain],
//   };
// }

// =================================
// =====     Relayer Agent     =====
// =================================

export type MatchingList = MatchingListElement[];

export interface MatchingListElement {
  originDomain?: '*' | number | number[];
  senderAddress?: '*' | string | string[];
  destinationDomain?: '*' | number | number[];
  recipientAddress?: '*' | string | string[];
}

export enum GasPaymentEnforcementPolicyType {
  None = 'none',
  Minimum = 'minimum',
  MeetsEstimatedCost = 'meetsEstimatedCost',
  OnChainFeeQuoting = 'onChainFeeQuoting',
}

export type GasPaymentEnforcementPolicy =
  | {
      type: GasPaymentEnforcementPolicyType.None;
    }
  | {
      type: GasPaymentEnforcementPolicyType.Minimum;
      payment: string; // An integer string, may be 0x-prefixed
    }
  | {
      type: GasPaymentEnforcementPolicyType.OnChainFeeQuoting;
      gasfraction?: string; // An optional string of "numerator / denominator", e.g. "1 / 2"
    };

export type GasPaymentEnforcementConfig = GasPaymentEnforcementPolicy & {
  matchingList?: MatchingList;
};

// Incomplete basic relayer agent config
interface BaseRelayerConfig {
  gasPaymentEnforcement: GasPaymentEnforcementConfig[];
  whitelist?: MatchingList;
  blacklist?: MatchingList;
  transactionGasLimit?: BigNumberish;
  skipTransactionGasLimitFor?: number[];
}

// Full relayer agent config for a single chain
interface RelayerConfig
  extends Omit<
    BaseRelayerConfig,
    | 'whitelist'
    | 'blacklist'
    | 'skipTransactionGasLimitFor'
    | 'transactionGasLimit'
    | 'gasPaymentEnforcement'
  > {
  relayChains: string;
  gasPaymentEnforcement: string;
  whitelist?: string;
  blacklist?: string;
  transactionGasLimit?: string;
  skipTransactionGasLimitFor?: string;
}

// =====================================
// =====     Checkpoint Syncer     =====
// =====================================

// These values are eventually passed to Rust, which expects the values to be camelCase
export const enum CheckpointSyncerType {
  LocalStorage = 'localStorage',
  S3 = 's3',
}

interface LocalCheckpointSyncerConfig {
  type: CheckpointSyncerType.LocalStorage;
  path: string;
}

interface S3CheckpointSyncerConfig {
  type: CheckpointSyncerType.S3;
  bucket: string;
  region: string;
}

export type CheckpointSyncerConfig =
  | LocalCheckpointSyncerConfig
  | S3CheckpointSyncerConfig;

// ===================================
// =====     Validator Agent     =====
// ===================================

// Validator agents for each chain.
export type ValidatorBaseChainConfigMap = ChainMap<ValidatorBaseChainConfig>;

interface ValidatorBaseChainConfig {
  // How frequently to check for new checkpoints
  interval: number;
  // The reorg_period in blocks
  reorgPeriod: number;
  // Individual validator agents
  validators: Array<ValidatorBaseConfig>;
}

// Configuration for a validator agent.
interface ValidatorBaseConfig {
  name: string;
  address: string;
  checkpointSyncer: CheckpointSyncerConfig;
}

// Full config for a single validator
interface ValidatorConfig {
  interval: number;
  reorgPeriod: number;
  originChainName: ChainName;
  checkpointSyncer: CheckpointSyncerConfig;
  validator: KeyConfig;
}

// Eventually consumed by Rust, which expects camelCase values
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

interface BaseScraperConfig {
  // no configs at this time
  __placeholder?: undefined;
}

type ScraperConfig = BaseScraperConfig;

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
  // // RC contexts do not provide validators
  // validators?: ChainValidatorConfigs;
  // relayer?: BaseRelayerConfig;
  // scraper?: BaseScraperConfig;

  // Roles to manage keys for
  rolesWithKeys: KEY_ROLE_ENUM[];
}

type WithOverrideableBase<T> = T & { baseOverride?: Partial<BaseAgentConfig> };

// Full agent configuration
export interface AgentConfig extends BaseAgentConfig {
  relayer?: WithOverrideableBase<BaseRelayerConfig>;
  validators?: WithOverrideableBase<ValidatorBaseChainConfigMap>;
  scraper?: WithOverrideableBase<BaseScraperConfig>;
}

// Helper interface to build configs. Ensures all helpers have a similar interface.
interface ConfigHelper<T> {
  readonly isDefined: boolean;

  buildConfig(): Promise<T | undefined>;
}

abstract class AgentConfigHelper implements BaseAgentConfig {
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

export class ValidatorConfigHelper
  extends AgentConfigHelper
  implements ConfigHelper<Array<ValidatorConfig>>
{
  readonly #validatorsConfig?: ValidatorBaseChainConfigMap;

  constructor(agentConfig: AgentConfig, public readonly chainName: ChainName) {
    super(agentConfig, agentConfig.validators);
    this.#validatorsConfig = agentConfig.validators;
  }

  get isDefined(): boolean {
    return !!this.#validatorsConfig;
  }

  async buildConfig(): Promise<Array<ValidatorConfig> | undefined> {
    if (!this.isDefined) return undefined;

    return Promise.all(
      this.#chainConfig.validators.map(async (val, i) =>
        this.#configForValidator(val, i),
      ),
    );
  }

  async #configForValidator(
    cfg: ValidatorBaseConfig,
    idx: number,
  ): Promise<ValidatorConfig> {
    let validator: KeyConfig = { type: KeyType.Hex };
    if (cfg.checkpointSyncer.type == CheckpointSyncerType.S3) {
      const awsUser = new ValidatorAgentAwsUser(
        this.runEnv,
        this.context,
        this.chainName,
        idx,
        cfg.checkpointSyncer.region,
        cfg.checkpointSyncer.bucket,
      );
      await awsUser.createIfNotExists();
      await awsUser.createBucketIfNotExists();

      if (this.aws)
        validator = (await awsUser.createKeyIfNotExists(this)).keyConfig;
    } else {
      console.warn(
        `Validator ${cfg.address}'s checkpoint syncer is not S3-based. Be sure this is a non-k8s-based environment!`,
      );
    }

    return {
      interval: this.#chainConfig.interval,
      reorgPeriod: this.#chainConfig.reorgPeriod,
      checkpointSyncer: cfg.checkpointSyncer,
      originChainName: this.chainName!,
      validator,
    };
  }

  get #chainConfig(): ValidatorBaseChainConfig {
    return (this.#validatorsConfig ?? {})[this.chainName];
  }
}

export class RelayerConfigHelper
  extends AgentConfigHelper
  implements ConfigHelper<RelayerConfig>
{
  readonly #relayerConfig?: BaseRelayerConfig;

  constructor(agentConfig: AgentConfig) {
    super(agentConfig, agentConfig.relayer);
    this.#relayerConfig = agentConfig.relayer;
  }

  get isDefined(): boolean {
    return !!this.#relayerConfig;
  }

  async buildConfig(): Promise<RelayerConfig | undefined> {
    if (!this.isDefined) return undefined;
    const baseConfig = this.#relayerConfig!;

    const relayerConfig: RelayerConfig = {
      relayChains: this.contextChainNames.join(','),
      gasPaymentEnforcement: JSON.stringify(baseConfig.gasPaymentEnforcement),
    };

    if (baseConfig.whitelist) {
      relayerConfig.whitelist = JSON.stringify(baseConfig.whitelist);
    }
    if (baseConfig.blacklist) {
      relayerConfig.blacklist = JSON.stringify(baseConfig.blacklist);
    }
    if (baseConfig.transactionGasLimit) {
      relayerConfig.transactionGasLimit =
        baseConfig.transactionGasLimit.toString();
    }
    if (baseConfig.skipTransactionGasLimitFor) {
      relayerConfig.skipTransactionGasLimitFor =
        baseConfig.skipTransactionGasLimitFor.join(',');
    }

    return relayerConfig;
  }

  // Get the signer configuration for each chain by the chain name.
  async signers(): Promise<ChainMap<KeyConfig>> {
    if (!this.aws)
      return Object.fromEntries(
        this.contextChainNames.map((name) => [name, { type: KeyType.Hex }]),
      );

    const awsUser = new AgentAwsUser(
      this.runEnv,
      this.context,
      KEY_ROLE_ENUM.Relayer,
      this.aws.region,
    );
    await awsUser.createIfNotExists();
    const key = (await awsUser.createKeyIfNotExists(this)).keyConfig;
    return Object.fromEntries(
      this.contextChainNames.map((name) => [name, key]),
    );
  }

  // Returns whether the relayer requires AWS credentials
  get requiresAwsCredentials(): boolean {
    // If AWS is present on the agentConfig, we are using AWS keys and need credentials regardless.
    if (!this.aws) {
      console.warn(
        `Relayer does not have AWS credentials. Be sure this is a non-k8s-based environment!`,
      );
      return false;
    }

    return true;
  }
}

export class ScraperConfigHelper
  extends AgentConfigHelper
  implements ConfigHelper<ScraperConfig>
{
  readonly #scraperConfig?: BaseScraperConfig;

  constructor(agentConfig: AgentConfig) {
    super(agentConfig, agentConfig.scraper);
    this.#scraperConfig = agentConfig.scraper;
  }

  get isDefined(): boolean {
    return !!this.#scraperConfig;
  }

  async buildConfig(): Promise<ScraperConfig | undefined> {
    return this.isDefined ? undefined : {};
  }
}

/*
// Helper to get chain-specific agent configurations
export class ChainAgentConfig {
  constructor(
    public readonly agentConfig: AgentConfig,
    public readonly role: KEY_ROLE_ENUM,
    public readonly chainName?: ChainName,
  ) {
    if (!ALL_AGENT_ROLES.includes(role)) {
      throw new Error(`Invalid agent role: ${role}`);
    }
    if (chainName == KEY_ROLE_ENUM.Validator && !chainName) {
      throw new Error(`Validators require a chain name`);
    }
  }

  // Credentials are only needed if AWS keys are needed -- otherwise, the
  // key is pulled from GCP Secret Manager by the helm chart
  keyConfig(role: KEY_ROLE_ENUM): KeyConfig {
    if (this.awsKeys) {
      const key = new AgentAwsKey(this.agentConfig, role, this.chainName);
      return key.keyConfig;
    }
    return {
      type: KeyType.Hex,
    };
  }

  // Get the signer configuration for each chain by the chain name.
  async signers(): Promise<Record<string, KeyConfig>> {
    if (!this.awsKeys) {
      Object.fromEntries(
        this.agentConfig.contextChainNames.map((name) => [
          name,
          this.keyConfig(KEY_ROLE_ENUM.Relayer),
        ]),
      );
    }
    const awsUser = new AgentAwsUser(
      this.agentConfig.runEnv,
      this.agentConfig.context,
      KEY_ROLE_ENUM.Relayer,
      this.agentConfig.aws!.region,
      this.chainName,
    );
    await awsUser.createIfNotExists();
    const key = await awsUser.createKeyIfNotExists(this.agentConfig);
    return Object.fromEntries(
      this.agentConfig.contextChainNames.map((name) => [name, key.keyConfig]),
    );
  }

  async validatorConfigs(): Promise<Array<ValidatorConfig> | undefined> {
    if (!this.validatorEnabled) {
      return undefined;
    }
    const validatorsConf = this.agentConfig.validators![this.chainName!];

    return Promise.all(
      validatorsConf.validators.map(async (val, i) => {
        let validator: KeyConfig = {
          type: KeyType.Hex,
        };
        if (val.checkpointSyncer.type === CheckpointSyncerType.S3) {
          const awsUser = new ValidatorAgentAwsUser(
            this.agentConfig.runEnv,
            this.agentConfig.context,
            this.chainName!,
            i,
            val.checkpointSyncer.region,
            val.checkpointSyncer.bucket,
          );
          await awsUser.createIfNotExists();
          await awsUser.createBucketIfNotExists();

          if (this.awsKeys) {
            const key = await awsUser.createKeyIfNotExists(this.agentConfig);
            validator = key.keyConfig;
          }
        } else {
          console.warn(
            `Validator ${val.address}'s checkpoint syncer is not S3-based. Be sure this is a non-k8s-based environment!`,
          );
        }

        return {
          interval: validatorsConf.interval,
          reorgPeriod: validatorsConf.reorgPeriod,
          checkpointSyncer: val.checkpointSyncer,
          originChainName: this.chainName!,
          validator,
        };
      }),
    );
  }

  get validatorEnabled(): boolean {
    return this.agentConfig.validators !== undefined;
  }

  // Returns whether the relayer requires AWS credentials, creating them if required.
  async relayerRequiresAwsCredentials(): Promise<boolean> {
    // If AWS is present on the agentConfig, we are using AWS keys and need credentials regardless.
    // This is undefined if AWS is not required
    const awsRegion: string | undefined = this.agentConfig.aws?.region;

    if (awsRegion !== undefined) {
      const awsUser = new AgentAwsUser(
        this.agentConfig.runEnv,
        this.agentConfig.context,
        KEY_ROLE_ENUM.Relayer,
        awsRegion,
        this.chainName,
      );
      await awsUser.createIfNotExists();
      // If we're using AWS keys, ensure the key is created and the user can use it
      if (this.awsKeys) {
        await awsUser.createKeyIfNotExists(this.agentConfig);
      }
      return true;
    }
    console.warn(
      `Relayer does not have AWS credentials. Be sure this is a non-k8s-based environment!`,
    );
    return false;
  }

  get relayerConfig(): RelayerConfig | undefined {
    if (!this.relayerEnabled) {
      return undefined;
    }

    const baseConfig = getChainOverriddenConfig(
      this.agentConfig.relayer!,
      this.chainName,
    );

    const relayerConfig: RelayerConfig = {
      originChainName: this.chainName,
      gasPaymentEnforcement: JSON.stringify(baseConfig.gasPaymentEnforcement),
    };
    if (baseConfig.whitelist) {
      relayerConfig.whitelist = JSON.stringify(baseConfig.whitelist);
    }
    if (baseConfig.blacklist) {
      relayerConfig.blacklist = JSON.stringify(baseConfig.blacklist);
    }
    if (baseConfig.transactionGasLimit) {
      relayerConfig.transactionGasLimit =
        baseConfig.transactionGasLimit.toString();
    }
    if (baseConfig.skipTransactionGasLimitFor) {
      relayerConfig.skipTransactionGasLimitFor =
        baseConfig.skipTransactionGasLimitFor.join(',');
    }

    return relayerConfig;
  }

  get relayerEnabled(): boolean {
    return this.agentConfig.relayer !== undefined;
  }

  get validators(): ValidatorBaseChainConfig {
    return this.agentConfig.validators![this.chainName];
  }

  get awsKeys(): boolean {
    return this.agentConfig.aws !== undefined;
  }
}
*/
