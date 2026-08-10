import {
  AgentConfig,
  AgentSignerKeyType,
  ValidatorConfig as AgentValidatorConfig,
  ChainMap,
  ChainName,
  S3Config,
} from '@hyperlane-xyz/sdk';
import { isEVMLike } from '@hyperlane-xyz/utils';

import { getChain } from '../../../config/registry.js';
import { ValidatorAgentAwsUser } from '../../agents/aws/validator-user.js';
import { AgentGcpKmsKey } from '../../agents/gcp-kms/kms-key.js';
import { ValidatorAgentGcpUser } from '../../agents/gcp-kms/validator-user.js';
import { Role } from '../../roles.js';
import {
  createGcsBucketIfNotExists,
  grantPublicReadOnBucketIfNotExists,
} from '../../utils/gcloud.js';
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
  // The reorg_period in blocks or block tag; overrides chain metadata
  reorgPeriod: string | number;
  // Individual validator agents
  validators: Array<ValidatorBaseConfig>;
  // Opt-in per chain: populates additionalQuorumRpcUrls (additional public batch;
  // rpcUrls already votes in the same quorum group, so no private batch needed) for
  // the validator's safety-critical merkle tree hook reads. Defaults to false/unset
  // so quorum verification stays off until deliberately enabled for a chain,
  // rather than turning on for every chain at once. Independent of this, the
  // base hook still uses whatever rpcConsensusType the chain is configured
  // with (currently Quorum for mainnet Hyperlane/ReleaseCandidate validators).
  quorumVerificationEnabled?: boolean;
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
  reorgPeriod: string | number;
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
  | S3CheckpointSyncerConfig
  | GcsCheckpointSyncerConfig;

// These values are eventually passed to Rust, which expects the values to be camelCase
export const CheckpointSyncerType = {
  LocalStorage: 'localStorage',
  S3: 's3',
  Gcs: 'gcs',
} as const;

export type CheckpointSyncerType =
  (typeof CheckpointSyncerType)[keyof typeof CheckpointSyncerType];

export interface LocalCheckpointSyncerConfig {
  type: typeof CheckpointSyncerType.LocalStorage;
  path: string;
}

export type S3CheckpointSyncerConfig = S3Config & {
  type: typeof CheckpointSyncerType.S3;
};

export type GcsCheckpointSyncerConfig = {
  type: typeof CheckpointSyncerType.Gcs;
  bucket: string;
  folder?: string;
  serviceAccountKey?: string;
  userSecrets?: string;
  // Ambient credentials (GKE Workload Identity) instead of a key file/secret.
  useApplicationDefault?: boolean;
};

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
      reorgPeriod: this.#chainConfig.reorgPeriod,
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

  get quorumVerificationEnabled(): boolean {
    return this.#chainConfig.quorumVerificationEnabled ?? false;
  }

  get role(): Role {
    return Role.Validator;
  }

  async #configForValidator(
    cfg: ValidatorBaseConfig,
    idx: number,
  ): Promise<ValidatorConfig['validators'][number]> {
    const metadata = getChain(this.chainName);
    const protocol = metadata.protocol;

    let validator: KeyConfig = { type: AgentSignerKeyType.Hex };
    let chainSigner: KeyConfig | undefined = undefined;
    let checkpointSyncer: CheckpointSyncerConfig = cfg.checkpointSyncer;

    if (this.gcp) {
      // Key/bucket are per validator index, shared across chains via a folder
      // prefix (see AgentGcpKmsKey); the GSA granted access to them is scoped
      // per release/chain instead (see ValidatorAgentGcpUser).
      const bucketName = `${this.context}-${this.runEnv}-validator-${idx}`;
      await createGcsBucketIfNotExists(
        this.gcp.project,
        this.gcp.location,
        bucketName,
      );
      await grantPublicReadOnBucketIfNotExists(bucketName);

      const gcpKey = new AgentGcpKmsKey(this, this.role, idx);
      await gcpKey.createIfNotExists();

      const gcpUser = new ValidatorAgentGcpUser(
        this.runEnv,
        this.context,
        this.chainName,
        this.gcp.project,
      );
      await gcpUser.createServiceAccountIfNotExists();
      await gcpUser.grantAccessForIndex(gcpKey, bucketName);

      validator = gcpKey.keyConfig;
      checkpointSyncer = {
        type: CheckpointSyncerType.Gcs,
        bucket: bucketName,
        folder: this.chainName,
        useApplicationDefault: true,
      };

      // Mirrors the AWS path below — EVM-like chains only.
      if (isEVMLike(protocol)) {
        chainSigner = validator;
      }
    } else if (cfg.checkpointSyncer.type == CheckpointSyncerType.S3) {
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

        // AWS-based chain signer keys are only used for EVM-like chains
        if (isEVMLike(protocol)) {
          chainSigner = validator;
        }
      }
    } else {
      console.warn(
        `Validator ${cfg.address || cfg.name}'s checkpoint syncer is not S3-based. Be sure this is a non-k8s-based environment!`,
      );
    }

    // If the chainSigner isn't set to the AWS/GCP-based key above, then set the default.
    if (chainSigner === undefined) {
      chainSigner = defaultChainSignerKeyConfig(this.chainName);
    }

    return {
      checkpointSyncer,
      validator,
      chainSigner,
    };
  }

  get #chainConfig(): ValidatorBaseChainConfig {
    return (this.#validatorsConfig ?? {})[this.chainName];
  }
}
