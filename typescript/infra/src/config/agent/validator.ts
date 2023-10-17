import {
  AgentConfig,
  AgentSignerKeyType,
  ValidatorConfig as AgentValidatorConfig,
  ChainMap,
  ChainName,
} from '@hyperlane-xyz/sdk';

import { ValidatorAgentAwsUser } from '../../agents/aws';
import { Role } from '../../roles';
import { HelmStatefulSetValues } from '../infrastructure';

import { AgentConfigHelper, KeyConfig, RootAgentConfig } from './agent';

// Validator agents for each chain.
export type ValidatorBaseChainConfigMap = ChainMap<ValidatorBaseChainConfig>;

export interface ValidatorBaseChainConfig {
  // How frequently to check for new checkpoints
  interval: number;
  // The reorg_period in blocks; overrides chain metadata
  reorgPeriod: number;
  // Individual validator agents
  validators: Array<ValidatorBaseConfig>;
}

// Configuration for a validator agent.
export interface ValidatorBaseConfig {
  name: string;
  address: string;
  checkpointSyncer: CheckpointSyncerConfig;
}

export interface ValidatorConfig {
  interval: number;
  reorgPeriod: number;
  originChainName: ChainName;
  validators: Array<{
    checkpointSyncer: CheckpointSyncerConfig;
    validator: KeyConfig;
  }>;
}

export interface HelmValidatorValues extends HelmStatefulSetValues {
  configs?: Array<
    // only keep configs specific to the validator agent and then replace
    // the validator signing key with the version helm needs.
    Omit<AgentValidatorConfig, keyof AgentConfig | 'validator'> & {
      validator: KeyConfig;
    }
  >;
}

export type CheckpointSyncerConfig =
  | LocalCheckpointSyncerConfig
  | S3CheckpointSyncerConfig;

// These values are eventually passed to Rust, which expects the values to be camelCase
export const enum CheckpointSyncerType {
  LocalStorage = 'localStorage',
  S3 = 's3',
}

export interface LocalCheckpointSyncerConfig {
  type: CheckpointSyncerType.LocalStorage;
  path: string;
}

export interface S3CheckpointSyncerConfig {
  type: CheckpointSyncerType.S3;
  bucket: string;
  region: string;
}

export class ValidatorConfigHelper extends AgentConfigHelper<ValidatorConfig> {
  readonly #validatorsConfig: ValidatorBaseChainConfigMap;

  constructor(
    agentConfig: RootAgentConfig,
    public readonly chainName: ChainName,
  ) {
    if (!agentConfig.validators)
      throw Error('Validator is not defined for this context');
    super(agentConfig, agentConfig.validators);
    this.#validatorsConfig = agentConfig.validators.chains;
  }

  async buildConfig(): Promise<ValidatorConfig> {
    return {
      interval: this.#chainConfig.interval,
      reorgPeriod: this.#chainConfig.reorgPeriod,
      originChainName: this.chainName!,
      validators: await Promise.all(
        this.#chainConfig.validators.map((val, i) =>
          this.#configForValidator(val, i),
        ),
      ),
    };
  }

  get validators(): ValidatorBaseConfig[] {
    return this.#validatorsConfig[this.chainName].validators;
  }

  get role(): Role {
    return Role.Validator;
  }

  async #configForValidator(
    cfg: ValidatorBaseConfig,
    idx: number,
  ): Promise<ValidatorConfig['validators'][number]> {
    let validator: KeyConfig = { type: AgentSignerKeyType.Hex };
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
      checkpointSyncer: cfg.checkpointSyncer,
      validator,
    };
  }

  get #chainConfig(): ValidatorBaseChainConfig {
    return (this.#validatorsConfig ?? {})[this.chainName];
  }
}
