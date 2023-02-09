import { ChainMap, ChainName } from '@hyperlane-xyz/sdk';
import { types } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts';
import {
  AgentAwsKey,
  AgentAwsUser,
  ValidatorAgentAwsUser,
} from '../agents/aws';
import { KEY_ROLE_ENUM } from '../agents/roles';
import { gcpSecretExists } from '../utils/gcloud';

import { DeployEnvironment } from './environment';

// Allows a "default" config to be specified and any per-chain overrides.
interface ChainOverridableConfig<Chain extends ChainName, T> {
  default: T;
  chainOverrides?: Partial<ChainMap<Chain, Partial<T>>>;
}

// Returns the default config with any overriden values specified for the provided chain.
export function getChainOverriddenConfig<Chain extends ChainName, T>(
  overridableConfig: ChainOverridableConfig<Chain, T>,
  chain: Chain,
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
  originDomain?: '*' | string | string[] | number | number[];
  senderAddress?: '*' | string | string[];
  destinationDomain?: '*' | string | string[] | number | number[];
  recipientAddress?: '*' | string | string[];
}

export enum GasPaymentEnforcementPolicyType {
  None = 'none',
  Minimum = 'minimum',
  MeetsEstimatedCost = 'meetsEstimatedCost',
}

export type GasPaymentEnforcementPolicy =
  | {
      type: GasPaymentEnforcementPolicyType.None;
    }
  | {
      type: GasPaymentEnforcementPolicyType.Minimum;
      payment: string | number;
    }
  | {
      type: GasPaymentEnforcementPolicyType.MeetsEstimatedCost;
    };

export interface GasPaymentEnforcementConfig {
  policy: GasPaymentEnforcementPolicy;
  whitelist?: MatchingList;
}

// Incomplete basic relayer agent config
interface BaseRelayerConfig {
  gasPaymentEnforcement: GasPaymentEnforcementConfig;
  whitelist?: MatchingList;
  blacklist?: MatchingList;
  transactionGasLimit?: bigint;
  skipTransactionGasLimitFor?: number[];
}

// Per-chain relayer agent configs
type ChainRelayerConfigs<Chain extends ChainName> = ChainOverridableConfig<
  Chain,
  BaseRelayerConfig
>;

interface SerializableGasPaymentEnforcementConfig
  extends Omit<GasPaymentEnforcementConfig, 'whitelist'> {
  whitelist?: string;
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
  originChainName: ChainName;
  gasPaymentEnforcement: SerializableGasPaymentEnforcementConfig;
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
export type ChainValidatorConfigs<Chain extends ChainName> = ChainMap<
  Chain,
  ValidatorChainConfig
>;

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

export interface GelatoConfig<Chain extends ChainName> {
  // List of chains in which using Gelato is enabled for
  enabledChains: Chain[];
}

export enum TransactionSubmissionType {
  Signer = 'signer',
  Gelato = 'gelato',
}

export interface AgentConfig<Chain extends ChainName> {
  environment: string;
  namespace: string;
  runEnv: DeployEnvironment;
  context: Contexts;
  docker: DockerConfig;
  quorumProvider?: boolean;
  connectionType: ConnectionType;
  index?: IndexingConfig;
  aws?: AwsConfig;
  // Names of all chains in the environment
  environmentChainNames: Chain[];
  // Names of chains this context cares about
  contextChainNames: Chain[];
  gelato?: GelatoConfig<Chain>;
  // RC contexts do not provide validators
  validators?: ChainValidatorConfigs<Chain>;
  relayer?: ChainRelayerConfigs<Chain>;
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
  domain: string;
  signer?: RustSigner | null;
  finalityBlocks: string;
  addresses: RustCoreAddresses;
  protocol: 'ethereum' | 'fuel';
  connection: RustConnection;
  index?: { from: string };
};

export type RustConfig<Chain extends ChainName> = {
  environment: DeployEnvironment;
  chains: Partial<ChainMap<Chain, RustChainSetup>>;
  // TODO: Separate DBs for each chain (fold into RustChainSetup)
  db: string;
  tracing: {
    level: string;
    fmt: 'json';
  };
};

// Helper to get chain-specific agent configurations
export class ChainAgentConfig<Chain extends ChainName> {
  constructor(
    public readonly agentConfig: AgentConfig<Chain>,
    public readonly chainName: Chain,
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
      this.agentConfig.environment,
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
            this.agentConfig.environment,
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
        this.agentConfig.environment,
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
      gasPaymentEnforcement: {
        ...baseConfig.gasPaymentEnforcement,
        whitelist: baseConfig.gasPaymentEnforcement.whitelist
          ? JSON.stringify(baseConfig.gasPaymentEnforcement.whitelist)
          : undefined,
      },
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

  // Returns if it's required, throws if it's required and isn't present.
  async ensureGelatoApiKeySecretExistsIfRequired(): Promise<boolean> {
    // No need to check anything if no chains require Gelato
    if (
      !this.agentConfig.gelato ||
      this.agentConfig.gelato.enabledChains.length == 0
    ) {
      return false;
    }

    // Check to see if the Gelato API key exists in GCP secret manager - throw if it doesn't
    const secretName = `${this.agentConfig.runEnv}-gelato-api-key`;
    const secretExists = await gcpSecretExists(secretName);
    if (!secretExists) {
      throw Error(
        `Expected Gelato API Key GCP Secret named ${secretName} to exist, have you created it?`,
      );
    }
    return true;
  }

  async ensureCoingeckoApiKeySecretExistsIfRequired() {
    // The CoinGecko API Key is only needed when using the "MeetsEstimatedCost" policy.
    if (
      this.relayerConfig?.gasPaymentEnforcement.policy.type !==
      GasPaymentEnforcementPolicyType.MeetsEstimatedCost
    ) {
      return;
    }
    // Check to see if the Gelato API key exists in GCP secret manager - throw if it doesn't
    const secretName = `${this.agentConfig.runEnv}-coingecko-api-key`;
    const secretExists = await gcpSecretExists(secretName);
    if (!secretExists) {
      throw Error(
        `Expected CoinGecko API Key GCP Secret named ${secretName} to exist, have you created it?`,
      );
    }
  }

  transactionSubmissionType(chain: Chain): TransactionSubmissionType {
    if (this.agentConfig.gelato?.enabledChains.includes(chain)) {
      return TransactionSubmissionType.Gelato;
    }

    return TransactionSubmissionType.Signer;
  }

  get validators(): ValidatorChainConfig {
    return this.agentConfig.validators![this.chainName];
  }

  get awsKeys(): boolean {
    return this.agentConfig.aws !== undefined;
  }
}
