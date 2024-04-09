import {
  AgentConfig,
  AgentSignerKeyType,
  ValidatorConfig as AgentValidatorConfig,
  ChainMap,
  ChainName,
  chainMetadata,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { ValidatorAgentAwsUser } from '../../agents/aws/validator-user.js';
import { Role } from '../../roles.js';
import { HelmStatefulSetValues } from '../infrastructure.js';

import {
  AgentConfigHelper,
  KeyConfig,
  RootAgentConfig,
  defaultChainSignerKeyConfig,
} from './agent.js';

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
  originChainName: ChainName;
  validators: Array<{
    checkpointSyncer: CheckpointSyncerConfig;
    // The key that signs checkpoints
    validator: KeyConfig;
    // The key that signs txs (e.g. self-announcements)
    chainSigner: KeyConfig | undefined;
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
    const metadata = chainMetadata[this.chainName];
    const protocol = metadata.protocol;

    let validator: KeyConfig = { type: AgentSignerKeyType.Hex };
    let chainSigner: KeyConfig | undefined = undefined;

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

      if (this.aws) {
        validator = (await awsUser.createKeyIfNotExists(this)).keyConfig;

        // AWS-based chain signer keys are only used for Ethereum
        if (protocol === ProtocolType.Ethereum) {
          chainSigner = validator;
        }
      }
    } else {
      console.warn(
        `Validator ${cfg.address}'s checkpoint syncer is not S3-based. Be sure this is a non-k8s-based environment!`,
      );
    }

    // If the chainSigner isn't set to the AWS-based key above, then set the default.
    if (chainSigner === undefined) {
      chainSigner = defaultChainSignerKeyConfig(this.chainName);
    }

    return {
      checkpointSyncer: cfg.checkpointSyncer,
      validator,
      chainSigner,
    };
  }

  get #chainConfig(): ValidatorBaseChainConfig {
    return (this.#validatorsConfig ?? {})[this.chainName];
  }
}
