import { types } from '@abacus-network/utils';
import { ChainName, ChainSubsetMap } from '@abacus-network/sdk';
import { DeployEnvironment } from './environment';
import { ValidatorAgentAwsUser } from '../agents/aws';

// Allows a "default" config to be specified and any per-network overrides.
interface ChainOverridableConfig<Networks extends ChainName, T> {
  default: T;
  chainOverrides?: Partial<ChainSubsetMap<Networks, T>>;
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
export type ChainValidatorSets<Networks extends ChainName> = ChainSubsetMap<
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
  environment: DeployEnvironment;
  namespace: string;
  runEnv: string;
  docker: DockerConfig;
  index?: IndexingConfig;
  aws?: AwsConfig;
  validatorSets: ChainValidatorSets<Networks>;
  validator: ChainValidatorConfigs<Networks>;
  relayer: ChainRelayerConfigs<Networks>;
  checkpointer: ChainCheckpointerConfigs<Networks>;
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

export type RustConfig = {
  environment: DeployEnvironment;
  signers: Partial<Record<ChainName, RustSigner>>;
  inboxes: Partial<Record<ChainName, RustContractBlock<InboxAddresses>>>;
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

  async validatorConfigs(): Promise<Array<ValidatorConfig>> {
    const baseConfig = getChainOverriddenConfig(
      this.agentConfig.validator,
      this.chainName,
    );

    return Promise.all(
      this.validatorSet.validators.map(async (val, i) => {
        if (val.checkpointSyncer.type === CheckpointSyncerType.S3) {
          const awsUser = new ValidatorAgentAwsUser(
            this.agentConfig.environment,
            this.chainName,
            i,
            val.checkpointSyncer.region,
            val.checkpointSyncer.bucket,
          );
          await awsUser.createIfNotExists();
          await awsUser.createBucketIfNotExists();
        }
        return {
          ...baseConfig,
          checkpointSyncer: val.checkpointSyncer,
        };
      }),
    );
  }

  async relayerConfig(): Promise<RelayerConfig> {
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

    // If there is an S3 checkpoint syncer, we need AWS credentials
    if (this.s3CheckpointSyncerExists) {
      // const awsUser =
    }

    return {
      ...baseConfig,
      multisigCheckpointSyncer: {
        threshold: this.validatorSet.threshold,
        checkpointSyncers,
      },
    };
  }

  get checkpointerConfig(): CheckpointerConfig {
    return getChainOverriddenConfig(
      this.agentConfig.checkpointer,
      this.chainName,
    );
  }

  get kathyConfig(): KathyConfig | undefined {
    if (!this.agentConfig.kathy) {
      return undefined;
    }
    return getChainOverriddenConfig(this.agentConfig.kathy, this.chainName);
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
}
