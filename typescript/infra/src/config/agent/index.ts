// Eventually consumed by Rust, which expects camelCase values
import { AgentConnectionType, ChainName } from '@hyperlane-xyz/sdk';

import { Contexts } from '../../../config/contexts';
import { KEY_ROLE_ENUM } from '../../agents/roles';
import { DeployEnvironment } from '../environment';

import { BaseRelayerConfig } from './relayer';
import { BaseScraperConfig } from './scraper';
import { ValidatorBaseChainConfigMap } from './validator';

export {
  ValidatorConfigHelper,
  CheckpointSyncerType,
  ValidatorBaseChainConfigMap,
} from './validator';
export {
  RelayerConfigHelper,
  GasPaymentEnforcementPolicyType,
} from './relayer';
export { ScraperConfigHelper } from './scraper';

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
