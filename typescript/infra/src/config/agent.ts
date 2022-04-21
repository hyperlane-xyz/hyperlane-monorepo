import { types } from '@abacus-network/utils';
import { ChainName } from '@abacus-network/sdk';
import { DeployEnvironment } from './environment';

interface IndexingConfig {
  from: number;
  chunk: number;
}

interface AwsConfig {
  region: string;
}

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
  checkpointSyncers: {
    [validatorAddress: string]: CheckpointSyncerConfig;
  };
}

interface BaseRelayerConfig {
  // The minimum latency in seconds between two relayed checkpoints on the inbox
  submissionLatency: number;
  // The polling interval to check for new checkpoints in seconds
  pollingInterval?: number;
  // The maxinmum number of times a processor will try to process a message
  maxRetries?: number;
  // Whether the CheckpointRelayer should try to immediately process messages
  relayerMessageProcessing?: boolean;
}

interface OverridableAgentConfig<T> {
  default: T;
  chainOverrides?: ChainConfig<T>;
}

export function getConfig<T>(
  overridableConfig: OverridableAgentConfig<T>,
  chain: ChainName,
) {
  return {
    ...overridableConfig.default,
    ...overridableConfig.chainOverrides?.[chain],
  };
}

interface ValidatorSet {
  threshold: number;
  validators: Array<Validator>;
}

interface Validator {
  address: string;
  checkpointSyncer: CheckpointSyncerConfig;
}

type ChainConfig<T> = {
  [chain in ChainName]?: T;
};

export type ValidatorSets = ChainConfig<ValidatorSet>;

type BaseRelayersConfig = OverridableAgentConfig<BaseRelayerConfig>;

interface BaseValidatorConfig {
  // How frequently to check for new checkpoints
  interval: number;
  // The reorg_period in blocks
  reorgPeriod: number;
}

type BaseValidatorsConfig = OverridableAgentConfig<BaseValidatorConfig>;

interface CheckpointerConfig {
  // Polling interval (in seconds)
  pollingInterval: number;
  // Minimum time between created checkpoints (in seconds)
  creationLatency: number;
}

type CheckpointersConfig = OverridableAgentConfig<CheckpointerConfig>;

export interface DockerConfig {
  repo: string;
  tag: string;
}

export interface AgentConfig {
  environment: DeployEnvironment;
  namespace: string;
  runEnv: string;
  docker: DockerConfig;
  index?: IndexingConfig;
  aws?: AwsConfig;
  validator: BaseValidatorsConfig;
  relayer: BaseRelayersConfig;
  checkpointer: CheckpointersConfig;
  validatorSets: ValidatorSets;
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

interface RelayerConfig extends BaseRelayerConfig {
  multisigCheckpointSyncer: MultisigCheckpointSyncerConfig;
}

interface ValidatorConfig extends BaseValidatorConfig {
  checkpointSyncer: CheckpointSyncerConfig;
}

export class ChainAgentConfig {
  constructor(
    public readonly agentConfig: AgentConfig,
    public readonly chainName: ChainName,
  ) {}

  get validatorSet(): ValidatorSet {
    const validatorSet = this.agentConfig.validatorSets[this.chainName];
    if (!validatorSet) {
      throw Error(`No validator set for chain ${this.chainName}`);
    }
    return validatorSet;
  }

  get validatorConfigs(): Array<ValidatorConfig> {
    if (!this.agentConfig.validator) {
      throw Error('No relayer config');
    }
    const baseConfig = getConfig(this.agentConfig.validator, this.chainName);

    const validatorSet = this.agentConfig.validatorSets[this.chainName];
    if (!validatorSet) {
      throw Error(`No validator set for chain ${this.chainName}`);
    }
    return validatorSet.validators.map((val) => ({
      ...baseConfig,
      checkpointSyncer: val.checkpointSyncer,
    }));
  }

  get relayerConfig(): RelayerConfig {
    const baseConfig = getConfig(this.agentConfig.relayer, this.chainName);

    const validatorSet = this.agentConfig.validatorSets[this.chainName];
    if (!validatorSet) {
      throw Error(`No validator set for chain ${this.chainName}`);
    }
    const checkpointSyncers = validatorSet.validators.reduce(
      (agg, val) => ({
        ...agg,
        [val.address]: val.checkpointSyncer,
      }),
      {},
    );

    return {
      ...baseConfig,
      multisigCheckpointSyncer: {
        threshold: validatorSet.threshold,
        checkpointSyncers,
      },
    };
  }

  get checkpointerConfig(): CheckpointerConfig {
    return getConfig(this.agentConfig.checkpointer, this.chainName);
  }
}
