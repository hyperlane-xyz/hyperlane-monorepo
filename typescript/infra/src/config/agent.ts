import { BigNumberish } from 'ethers';

import { ChainMap, ChainName } from '@hyperlane-xyz/sdk';
import { types } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts';
import {
  AgentAwsKey,
  AgentAwsUser,
  ValidatorAgentAwsUser,
} from '../agents/aws';
import { KEY_ROLE_ENUM } from '../agents/roles';

import { DeployEnvironment } from './environment';

// Allows a "default" config to be specified and any per-chain overrides.
interface ChainOverridableConfig<T> {
  default: T;
  chainOverrides?: ChainMap<Partial<T>>;
}

// Returns the default config with any overridden values specified for the provided chain.
export function getChainOverriddenConfig<T>(
  overridableConfig: ChainOverridableConfig<T>,
  chain: ChainName,
): T {
  return {
    ...overridableConfig.default,
    ...overridableConfig.chainOverrides?.[chain],
  };
}

// =================================
// =====     Relayer Agent     =====
// =================================

export type MatchingList = MatchingListElement[];

interface MatchingListElement {
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

// Per-chain relayer agent configs
type ChainRelayerConfigs = ChainOverridableConfig<BaseRelayerConfig>;

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
  originChainName: ChainName;
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

// Configuration for a validator agent.
interface ValidatorBaseConfig {
  name: string;
  address: string;
  checkpointSyncer: CheckpointSyncerConfig;
}

interface ValidatorChainConfig {
  // How frequently to check for new checkpoints
  interval: number;
  // The reorg_period in blocks
  reorgPeriod: number;
  // Individual validator agents
  validators: Array<ValidatorBaseConfig>;
}

// Validator agents for each chain.
export type ChainValidatorConfigs = ChainMap<ValidatorChainConfig>;

// Helm config for a single validator
interface ValidatorHelmConfig {
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

export enum TransactionSubmissionType {
  Signer = 'signer',
}

export interface AgentConfig {
  runEnv: DeployEnvironment;
  namespace: string;
  context: Contexts;
  docker: DockerConfig;
  quorumProvider?: boolean;
  connectionType: ConnectionType;
  index?: IndexingConfig;
  aws?: AwsConfig;
  // Names of all chains in the environment
  environmentChainNames: ChainName[];
  // Names of chains this context cares about
  contextChainNames: ChainName[];
  // RC contexts do not provide validators
  validators?: ChainValidatorConfigs;
  relayer?: ChainRelayerConfigs;
  // Roles to manage keys for
  rolesWithKeys: KEY_ROLE_ENUM[];
}

export type RustSigner = {
  key: string;
  type: string; // TODO
};

export enum ConnectionType {
  Http = 'http',
  Ws = 'ws',
  HttpQuorum = 'httpQuorum',
  HttpFallback = 'httpFallback',
}

export type RustConnection =
  | {
      type: ConnectionType.Http;
      url: string;
    }
  | { type: ConnectionType.Ws; url: string }
  | { type: ConnectionType.HttpQuorum; urls: string };

export type RustCoreAddresses = {
  mailbox: types.Address;
  interchainGasPaymaster: types.Address;
  validatorAnnounce: types.Address;
};

export type RustChainSetup = {
  name: ChainName;
  domain: number;
  signer?: RustSigner | null;
  finalityBlocks: number;
  addresses: RustCoreAddresses;
  protocol: 'ethereum' | 'fuel';
  connection: RustConnection;
  index?: { from: number };
};

export type RustConfig = {
  chains: Partial<ChainMap<RustChainSetup>>;
  // TODO: Separate DBs for each chain (fold into RustChainSetup)
  db: string;
  tracing: {
    level: string;
    fmt: 'json';
  };
};

// Helper to get chain-specific agent configurations
export class ChainAgentConfig {
  constructor(
    public readonly agentConfig: AgentConfig,
    public readonly chainName: ChainName,
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

  async validatorConfigs(): Promise<Array<ValidatorHelmConfig> | undefined> {
    if (!this.validatorEnabled) {
      return undefined;
    }

    return Promise.all(
      this.validators.validators.map(async (val, i) => {
        let validator: KeyConfig = {
          type: KeyType.Hex,
        };
        if (val.checkpointSyncer.type === CheckpointSyncerType.S3) {
          const awsUser = new ValidatorAgentAwsUser(
            this.agentConfig.runEnv,
            this.agentConfig.context,
            this.chainName,
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
          interval: this.validators.interval,
          reorgPeriod: this.validators.reorgPeriod,
          checkpointSyncer: val.checkpointSyncer,
          originChainName: this.chainName,
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

  get validators(): ValidatorChainConfig {
    return this.agentConfig.validators![this.chainName];
  }

  get awsKeys(): boolean {
    return this.agentConfig.aws !== undefined;
  }
}
