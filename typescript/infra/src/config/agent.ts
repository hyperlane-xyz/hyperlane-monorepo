import { ChainMap, ChainName, RemoteChainMap } from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';

import {
  AgentAwsKey,
  AgentAwsUser,
  ValidatorAgentAwsUser,
} from '../agents/aws';
import { KEY_ROLE_ENUM } from '../agents/roles';

import { DeployEnvironment } from './environment';

// Allows a "default" config to be specified and any per-network overrides.
interface ChainOverridableConfig<Networks extends ChainName, T> {
  default: T;
  chainOverrides?: Partial<ChainMap<Networks, T>>;
}

// Returns the default config with any overriden values specified for the provided chain.
export function getChainOverriddenConfig<Networks extends ChainName, T>(
  overridableConfig: ChainOverridableConfig<Networks, T>,
  chain: Networks,
): T {
  return {
    ...overridableConfig.default,
    ...overridableConfig.chainOverrides?.[chain],
  };
}

// =====================================
// =====     Checkpoint Syncer     =====
// =====================================

// These values are eventually passed to Rust, which expects the values to be camelCase
export enum CheckpointSyncerType {
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

interface MultisigCheckpointSyncerConfig {
  threshold: number;
  // Keyed by validator address
  checkpointSyncers: Record<string, CheckpointSyncerConfig>;
}

// =================================
// =====     Validator Set     =====
// =================================

// A validator set for a single chain
interface ValidatorSet {
  threshold: number;
  validators: Array<Validator>;
}

// A validator. This isn't agent-specific configuration, just information
// on the validator that is enrolled in a validator set.
interface Validator {
  address: string;
  checkpointSyncer: CheckpointSyncerConfig;
}

// Validator sets for each network
export type ChainValidatorSets<Networks extends ChainName> = ChainMap<
  Networks,
  ValidatorSet
>;

// =================================
// =====     Relayer Agent     =====
// =================================

// Incomplete basic relayer agent config
interface BaseRelayerConfig {
  // The minimum latency in seconds between two relayed checkpoints on the inbox
  submissionLatency: number;
  // The polling interval to check for new checkpoints in seconds
  pollingInterval: number;
  // The maxinmum number of times a processor will try to process a message
  maxRetries: number;
  // Whether the CheckpointRelayer should try to immediately process messages
  relayerMessageProcessing: boolean;
}

// Per-chain relayer agent configs
type ChainRelayerConfigs<Networks extends ChainName> = ChainOverridableConfig<
  Networks,
  BaseRelayerConfig
>;

// Full relayer agent config for a single chain
interface RelayerConfig extends BaseRelayerConfig {
  multisigCheckpointSyncer: MultisigCheckpointSyncerConfig;
}

// ===================================
// =====     Validator Agent     =====
// ===================================

// Incomplete basic validator agent config
interface BaseValidatorConfig {
  // How frequently to check for new checkpoints
  interval: number;
  // The reorg_period in blocks
  reorgPeriod: number;
}

// Per-chain validator agent configs
type ChainValidatorConfigs<Networks extends ChainName> = ChainOverridableConfig<
  Networks,
  BaseValidatorConfig
>;

// Full validator agent config for a single chain
interface ValidatorConfig extends BaseValidatorConfig {
  checkpointSyncer: CheckpointSyncerConfig;
  validator: KeyConfig;
}

// ======================================
// =====     Checkpointer Agent     =====
// ======================================

// Full checkpointer agent config for a single chain
interface CheckpointerConfig {
  // Polling interval (in seconds)
  pollingInterval: number;
  // Minimum time between created checkpoints (in seconds)
  creationLatency: number;
}

// Per-chain checkpointer agent configs
type ChainCheckpointerConfigs<Networks extends ChainName> =
  ChainOverridableConfig<Networks, CheckpointerConfig>;

// ===============================
// =====     Kathy Agent     =====
// ===============================

// Full kathy agent config for a single chain
interface KathyConfig {
  // The message interval (in seconds)
  interval: number;
}

// Per-chain kathy agent configs
type ChainKathyConfigs<Networks extends ChainName> = ChainOverridableConfig<
  Networks,
  KathyConfig
>;

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

export interface AgentConfig<Networks extends ChainName> {
  environment: string;
  namespace: string;
  runEnv: string;
  docker: DockerConfig;
  index?: IndexingConfig;
  aws?: AwsConfig;
  chainNames: Networks[];
  validatorSets: ChainValidatorSets<Networks>;
  validator: ChainValidatorConfigs<Networks>;
  relayer: ChainRelayerConfigs<Networks>;
  checkpointer?: ChainCheckpointerConfigs<Networks>;
  kathy?: ChainKathyConfigs<Networks>;
}

export type RustSigner = {
  key: string;
  type: string; // TODO
};

export type RustConnection = {
  type: string; // TODO
  url: string;
};

export type RustContractBlock<T> = {
  addresses: T;
  domain: string;
  name: ChainName;
  rpcStyle: string; // TODO
  connection: RustConnection;
};

export type OutboxAddresses = {
  outbox: types.Address;
};

export type InboxAddresses = {
  inbox: types.Address;
  validatorManager: types.Address;
};

export type RustConfig<Networks extends ChainName> = {
  environment: DeployEnvironment;
  index?: { from: string };
  signers: Partial<ChainMap<Networks, RustSigner>>;
  inboxes: RemoteChainMap<Networks, any, RustContractBlock<InboxAddresses>>;
  outbox: RustContractBlock<OutboxAddresses>;
  tracing: {
    level: string;
    fmt: 'json';
  };
  db: string;
};

// Helper to get chain-specific agent configurations
export class ChainAgentConfig<Networks extends ChainName> {
  constructor(
    public readonly agentConfig: AgentConfig<Networks>,
    public readonly chainName: Networks,
  ) {}

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

  signers(role: KEY_ROLE_ENUM) {
    return this.agentConfig.chainNames.map((name) => ({
      name,
      keyConfig: this.keyConfig(role),
    }));
  }

  async validatorConfigs(): Promise<Array<ValidatorConfig>> {
    const baseConfig = getChainOverriddenConfig(
      this.agentConfig.validator,
      this.chainName,
    );

    return Promise.all(
      this.validatorSet.validators.map(async (val, i) => {
        if (val.checkpointSyncer.type !== CheckpointSyncerType.S3) {
          throw Error(
            'Expected k8s-based validator to use S3 checkpoint syncer',
          );
        }

        const awsUser = new ValidatorAgentAwsUser(
          this.agentConfig.environment,
          this.chainName,
          i,
          val.checkpointSyncer.region,
          val.checkpointSyncer.bucket,
        );
        await awsUser.createIfNotExists();
        await awsUser.createBucketIfNotExists();

        let validator: KeyConfig = {
          type: KeyType.Hex,
        };
        if (this.awsKeys) {
          const key = await awsUser.createKeyIfNotExists(this.agentConfig);
          validator = key.keyConfig;
        }

        return {
          ...baseConfig,
          checkpointSyncer: val.checkpointSyncer,
          validator,
        };
      }),
    );
  }

  // Returns whetehr the relayer requires AWS credentials, creating them if required.
  async relayerRequiresAwsCredentials(): Promise<boolean> {
    // If there is an S3 checkpoint syncer, we need AWS credentials.
    // We ensure they are created here, but they are actually read from using `external-secrets`
    // on the cluster.
    const firstS3Syncer = this.validatorSet.validators.find(
      (validator) =>
        validator.checkpointSyncer.type === CheckpointSyncerType.S3,
    )?.checkpointSyncer as S3CheckpointSyncerConfig | undefined;

    // If AWS is present on the agentConfig, we are using AWS keys and need credentials regardless.
    // This is undefined if AWS is not required
    const awsRegion: string | undefined =
      this.agentConfig.aws?.region ?? firstS3Syncer?.region;

    if (awsRegion !== undefined) {
      const awsUser = new AgentAwsUser(
        this.agentConfig.environment,
        this.chainName,
        KEY_ROLE_ENUM.Relayer,
        awsRegion,
      );
      await awsUser.createIfNotExists();
      // If we're using AWS keys, ensure the key is created and the user can use it
      if (this.awsKeys) {
        await awsUser.createKeyIfNotExists(this.agentConfig);
      }
      return true;
    }
    return false;
  }

  async relayerSigners() {
    if (!this.awsKeys) {
      return this.signers(KEY_ROLE_ENUM.Relayer);
    }
    const awsUser = new AgentAwsUser(
      this.agentConfig.environment,
      this.chainName,
      KEY_ROLE_ENUM.Relayer,
      this.agentConfig.aws!.region,
    );
    await awsUser.createIfNotExists();
    const key = await awsUser.createKeyIfNotExists(this.agentConfig);
    return this.agentConfig.chainNames.map((name) => ({
      name,
      keyConfig: key.keyConfig,
    }));
  }

  get relayerConfig(): RelayerConfig {
    const baseConfig = getChainOverriddenConfig(
      this.agentConfig.relayer,
      this.chainName,
    );

    const checkpointSyncers = this.validatorSet.validators.reduce(
      (agg, val) => ({
        ...agg,
        [val.address]: val.checkpointSyncer,
      }),
      {},
    );

    return {
      ...baseConfig,
      multisigCheckpointSyncer: {
        threshold: this.validatorSet.threshold,
        checkpointSyncers,
      },
    };
  }

  get checkpointerEnabled() {
    return this.agentConfig.checkpointer !== undefined;
  }

  checkpointerSigners() {
    if (!this.checkpointerEnabled) {
      return [];
    }
    return [
      {
        name: this.chainName,
        keyConfig: this.keyConfig(KEY_ROLE_ENUM.Kathy),
      },
    ];
  }

  get checkpointerRequiresAwsCredentials() {
    return this.awsKeys;
  }

  get checkpointerConfig(): CheckpointerConfig | undefined {
    if (!this.checkpointerEnabled) {
      return undefined;
    }
    return getChainOverriddenConfig(
      this.agentConfig.checkpointer!,
      this.chainName,
    );
  }

  // Gets signer info, creating them if necessary
  kathySigners() {
    if (!this.kathyEnabled) {
      return [];
    }
    return [
      {
        name: this.chainName,
        keyConfig: this.keyConfig(KEY_ROLE_ENUM.Kathy),
      },
    ];
  }

  get kathyRequiresAwsCredentials() {
    return this.awsKeys;
  }

  get kathyConfig(): KathyConfig | undefined {
    if (!this.agentConfig.kathy) {
      return undefined;
    }
    return getChainOverriddenConfig(this.agentConfig.kathy, this.chainName);
  }

  get kathyEnabled() {
    return this.kathyConfig !== undefined;
  }

  get validatorSet(): ValidatorSet {
    return this.agentConfig.validatorSets[this.chainName];
  }

  // Returns true if any of the validators in the validator set are using an S3 checkpoint syncer.
  get s3CheckpointSyncerExists(): boolean {
    return (
      this.validatorSet.validators.find(
        (validator) =>
          validator.checkpointSyncer.type === CheckpointSyncerType.S3,
      ) !== undefined
    );
  }

  get awsKeys(): boolean {
    return this.agentConfig.aws !== undefined;
  }
}
