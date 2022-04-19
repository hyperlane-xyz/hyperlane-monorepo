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

interface ProcessorConfig {
  indexOnly: string[];
  s3Bucket: string;
}

// Rust expects values to be camelCase
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

type CheckpointSyncerConfig = LocalCheckpointSyncerConfig | S3CheckpointSyncerConfig;

type MultisigCheckpointSyncerConfig = {
  // Quorum threshold
  threshold: number;
  // Mapping of validator address -> checkpoint syncer
  checkpointSyncers: {
    [validatorAddress: string]: CheckpointSyncerConfig;
  };
}

interface RelayerConfig {
  // The multisig checkpoint syncer configuration
  multisigCheckpointSyncer: MultisigCheckpointSyncerConfig;
  // The minimum latency in seconds between two relayed checkpoints on the inbox
  submissionLatency: number;
  // The polling interval to check for new checkpoints in seconds
  pollingInterval?: number;
  // The maxinmum number of times a processor will try to process a message
  maxRetries?: number;
  // Whether the CheckpointRelayer should try to immediately process messages
  relayerMessageProcessing?: boolean;
}

// /// The validator attestation signer
// validator: abacus_base::SignerConf,
// /// The checkpoint syncer configuration
// checkpointsyncer: abacus_base::CheckpointSyncerConf,
// /// The reorg_period in blocks
// reorgperiod: String,

interface ValidatorConfig {
  // How frequently to check for new checkpoints
  interval: number;
  // The reorg_period in blocks
  reorgPeriod: number;
  // The checkpoint syncer configuration
  checkpointSyncer: CheckpointSyncerConfig,
  // validator
}

interface CheckpointerConfig {
  // Polling interval (in seconds)
  pollingInterval: number;
  // Minimum time between created checkpoints (in seconds)
  creationLatency: number;
}

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
  processor?: ProcessorConfig;
  validator?: ValidatorConfig;
  relayer?: RelayerConfig;
  checkpointer?: CheckpointerConfig;
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
