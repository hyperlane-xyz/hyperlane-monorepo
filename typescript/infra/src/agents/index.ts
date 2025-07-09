import { join } from 'path';

import {
  AgentSealevelPriorityFeeOracle,
  AgentSealevelTransactionSubmitter,
  ChainName,
  RelayerConfig,
  RpcConsensusType,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, objOmitKeys } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { getChain } from '../../config/registry.js';
import {
  AgentConfigHelper,
  AgentContextConfig,
  DockerConfig,
  HelmRootAgentValues,
  KubernetesResources,
  RootAgentConfig,
} from '../config/agent/agent.js';
import {
  RelayerConfigHelper,
  RelayerConfigMapConfig,
  RelayerDbBootstrapConfig,
  RelayerEnvConfig,
} from '../config/agent/relayer.js';
import { ScraperConfigHelper } from '../config/agent/scraper.js';
import { ValidatorConfigHelper } from '../config/agent/validator.js';
import { DeployEnvironment } from '../config/environment.js';
import { AgentRole, Role } from '../roles.js';
import {
  createServiceAccountIfNotExists,
  createServiceAccountKey,
  fetchGCPSecret,
  gcpSecretExistsUsingClient,
  getGcpSecretLatestVersionName,
  grantServiceAccountStorageRoleIfNotExists,
  setGCPSecretUsingClient,
} from '../utils/gcloud.js';
import { HelmManager } from '../utils/helm.js';
import {
  execCmd,
  getInfraPath,
  isEthereumProtocolChain,
} from '../utils/utils.js';

import { AgentGCPKey } from './gcp.js';

const HELM_CHART_PATH = join(
  getInfraPath(),
  '/../../rust/main/helm/hyperlane-agent/',
);

export interface BatchConfig {
  maxBatchSize: number;
  bypassBatchSimulation: boolean;
  maxSubmitQueueLength?: number;
}

export abstract class AgentHelmManager extends HelmManager<HelmRootAgentValues> {
  abstract readonly role: AgentRole;
  readonly helmChartPath: string = HELM_CHART_PATH;
  protected abstract readonly config: AgentConfigHelper;

  // Number of indexes this agent has
  get length(): number {
    return 1;
  }

  get context(): Contexts {
    return this.config.context;
  }

  get environment(): DeployEnvironment {
    return this.config.runEnv;
  }

  get namespace(): string {
    return this.config.namespace;
  }

  async helmValues(): Promise<HelmRootAgentValues> {
    const dockerImage = this.dockerImage;
    return {
      image: {
        repository: dockerImage.repo,
        tag: dockerImage.tag,
      },
      hyperlane: {
        runEnv: this.environment,
        context: this.context,
        aws: !!this.config.aws,
        chains: this.config.contextChainNames[this.role].map((chain) => {
          const metadata = getChain(chain);
          const reorgPeriod = metadata.blocks?.reorgPeriod;
          if (reorgPeriod === undefined) {
            throw new Error(`No reorg period found for chain ${chain}`);
          }

          let priorityFeeOracle: AgentSealevelPriorityFeeOracle | undefined;
          if (getChain(chain).protocol === ProtocolType.Sealevel) {
            priorityFeeOracle =
              this.config.rawConfig.sealevel?.priorityFeeOracleConfigGetter?.(
                chain,
              );
          }

          let transactionSubmitter:
            | AgentSealevelTransactionSubmitter
            | undefined;
          if (getChain(chain).protocol === ProtocolType.Sealevel) {
            transactionSubmitter =
              this.config.rawConfig.sealevel?.transactionSubmitterConfigGetter?.(
                chain,
              );
          }

          const batchConfig = this.batchConfig(chain);

          return {
            name: chain,
            rpcConsensusType: this.rpcConsensusType(chain),
            protocol: metadata.protocol,
            blocks: { reorgPeriod },
            maxBatchSize: batchConfig.maxBatchSize,
            bypassBatchSimulation: batchConfig.bypassBatchSimulation,
            ...(batchConfig.maxSubmitQueueLength
              ? { maxSubmitQueueLength: batchConfig.maxSubmitQueueLength }
              : {}),
            priorityFeeOracle,
            transactionSubmitter,
          };
        }),
      },
    };
  }

  rpcConsensusType(chain: ChainName): RpcConsensusType {
    // Non-Ethereum chains only support Single
    if (!isEthereumProtocolChain(chain)) {
      return RpcConsensusType.Single;
    }

    return this.config.agentRoleConfig.rpcConsensusType;
  }

  get dockerImage(): DockerConfig {
    return this.config.agentRoleConfig.docker;
  }

  kubernetesResources(): KubernetesResources | undefined {
    return this.config.agentRoleConfig.resources;
  }

  batchConfig(_: ChainName): BatchConfig {
    return {
      maxBatchSize: 32,
      bypassBatchSimulation: false,
    };
  }
}

abstract class OmniscientAgentHelmManager extends AgentHelmManager {
  get helmReleaseName(): string {
    const parts = ['omniscient', this.role];
    // For backward compatibility reasons, don't include the context
    // in the name of the helm release if the context is the default "hyperlane"
    if (this.context != Contexts.Hyperlane) parts.push(this.context);
    return parts.join('-');
  }
}

abstract class MultichainAgentHelmManager extends AgentHelmManager {
  protected constructor(public readonly chainName: ChainName) {
    super();
  }

  get helmReleaseName(): string {
    const parts = [this.chainName, this.role];
    // For backward compatibility reasons, don't include the context
    // in the name of the helm release if the context is the default "hyperlane"
    if (this.context != Contexts.Hyperlane) parts.push(this.context);
    return parts.join('-');
  }

  get dockerImage(): DockerConfig {
    return this.config.dockerImageForChain(this.chainName);
  }
}

export class RelayerHelmManager extends OmniscientAgentHelmManager {
  protected readonly config: RelayerConfigHelper;
  readonly role: Role.Relayer = Role.Relayer;

  constructor(config: RootAgentConfig) {
    super();
    this.config = new RelayerConfigHelper(config);
  }

  async helmValues(): Promise<HelmRootAgentValues> {
    const values = await super.helmValues();

    const config = await this.config.buildConfig();

    // Divide the keys between the configmap and the env config.
    const configMapConfig: RelayerConfigMapConfig = {
      addressBlacklist: config.addressBlacklist,
      metricAppContexts: config.metricAppContexts,
      gasPaymentEnforcement: config.gasPaymentEnforcement,
      ismCacheConfigs: config.ismCacheConfigs,
    };
    const envConfig = objOmitKeys<RelayerConfig>(
      config,
      Object.keys(configMapConfig),
    ) as RelayerEnvConfig;

    values.hyperlane.relayer = {
      enabled: true,
      aws: this.config.requiresAwsCredentials,
      envConfig,
      configMapConfig,
      resources: this.kubernetesResources(),
      dbBootstrap: await this.dbBootstrapConfig(
        this.config.relayerConfig.dbBootstrap,
      ),
      mixing: this.config.relayerConfig.mixing ?? { enabled: false },
      // Enable by default in our infra
      environmentVariableEndpointEnabled:
        this.config.relayerConfig.environmentVariableEndpointEnabled ?? true,
      cacheDefaultExpirationSeconds:
        this.config.relayerConfig.cache?.defaultExpirationSeconds,
    };

    const signers = await this.config.signers();
    values.hyperlane.relayerChains = this.config.relayChains.map((name) => ({
      name,
      signer: signers[name],
    }));

    if (!values.tolerations) {
      values.tolerations = [];
    }

    // Relayer pods should only be scheduled on nodes with the component label set to relayer.
    // NoSchedule was chosen so that some daemonsets (like the prometheus node exporter) would not be evicted.
    values.tolerations.push({
      key: 'component',
      operator: 'Equal',
      value: 'relayer',
      effect: 'NoSchedule',
    });

    if (this.context.includes('vanguard')) {
      values.tolerations.push({
        key: 'context-family',
        operator: 'Equal',
        value: 'vanguard',
        effect: 'NoSchedule',
      });
    }

    return values;
  }

  batchConfig(chain: ChainName): BatchConfig {
    const defaultBatchConfig = super.batchConfig(chain);

    let maxBatchSize =
      this.config.relayerConfig.batch?.defaultBatchSize ??
      defaultBatchConfig.maxBatchSize;
    const chainBatchSizeOverride =
      this.config.relayerConfig.batch?.batchSizeOverrides?.[chain];
    if (chainBatchSizeOverride) {
      maxBatchSize = chainBatchSizeOverride;
    }

    return {
      maxBatchSize,
      bypassBatchSimulation:
        this.config.relayerConfig.batch?.bypassBatchSimulation ??
        defaultBatchConfig.bypassBatchSimulation,
      maxSubmitQueueLength:
        this.config.relayerConfig.batch?.maxSubmitQueueLength?.[chain],
    };
  }

  async dbBootstrapConfig(
    enabled: boolean = false,
  ): Promise<RelayerDbBootstrapConfig | undefined> {
    if (!enabled) {
      return undefined;
    }

    await this.ensureDbBootstrapGcpServiceAccount('relayer-db-backups');

    return {
      enabled: true,
      bucket: 'relayer-db-backups',
      object_targz: `${this.environment}-latest.tar.gz`,
    };
  }

  async ensureDbBootstrapGcpServiceAccount(bucket: string) {
    const secretName = this.dbBootstrapServiceAccountKeySecretName();

    if (await gcpSecretExistsUsingClient(secretName)) {
      // The secret already exists, no need to create it again
      return;
    }

    const STORAGE_OBJECT_VIEWER_ROLE = 'roles/storage.objectViewer';

    const serviceAccountEmail = await createServiceAccountIfNotExists(
      `${this.environment}-db-bootstrap-reader`,
    );
    await grantServiceAccountStorageRoleIfNotExists(
      serviceAccountEmail,
      bucket,
      STORAGE_OBJECT_VIEWER_ROLE,
    );
    const key = await createServiceAccountKey(serviceAccountEmail);
    await setGCPSecretUsingClient(secretName, JSON.stringify(key));
  }

  dbBootstrapServiceAccountKeySecretName(): string {
    return `${this.environment}-relayer-db-bootstrap-viewer-key`;
  }
}

export class ScraperHelmManager extends OmniscientAgentHelmManager {
  protected readonly config: ScraperConfigHelper;
  readonly role: Role.Scraper = Role.Scraper;

  constructor(config: RootAgentConfig) {
    super();
    this.config = new ScraperConfigHelper(config);
    if (this.context != Contexts.Hyperlane)
      throw Error('Context does not support scraper');
  }

  async helmValues(): Promise<HelmRootAgentValues> {
    const values = await super.helmValues();
    values.hyperlane.scraper = {
      enabled: true,
      config: await this.config.buildConfig(),
      resources: this.kubernetesResources(),
    };
    // scraper never requires aws credentials
    values.hyperlane.aws = false;
    return values;
  }
}

export class ValidatorHelmManager extends MultichainAgentHelmManager {
  protected readonly config: ValidatorConfigHelper;
  readonly role: Role.Validator = Role.Validator;

  constructor(config: RootAgentConfig, chainName: ChainName) {
    super(chainName);
    this.config = new ValidatorConfigHelper(config, chainName);
    if (!this.config.contextChainNames[this.role].includes(chainName))
      throw Error('Context does not support chain');
    if (!this.config.environmentChainNames.includes(chainName))
      throw Error('Environment does not support chain');
  }

  get length(): number {
    return this.config.validators.length;
  }

  async helmValues(): Promise<HelmRootAgentValues> {
    const helmValues = await super.helmValues();
    const cfg = await this.config.buildConfig();

    // Only care about the origin chain for the helm values. This
    // prevents getting secret endpoints for all chains in the environment.
    helmValues.hyperlane.chains = helmValues.hyperlane.chains.filter(
      (chain) => chain.name === cfg.originChainName,
    );

    helmValues.hyperlane.validator = {
      enabled: true,
      configs: cfg.validators.map((c) => ({
        ...c,
        originChainName: cfg.originChainName,
        interval: cfg.interval,
      })),
      resources: this.kubernetesResources(),
    };

    // The name of the helm release for agents is `hyperlane-agent`.
    // This causes the name of the S3 bucket to exceed the 63 character limit in helm.
    // To work around this, we shorten the name of the helm release to `agent`
    if (this.config.context !== Contexts.Hyperlane) {
      helmValues.nameOverride = 'agent';
    }

    return helmValues;
  }
}

export function getSecretName(
  environment: string,
  chainName: ChainName,
): string {
  return `${environment}-rpc-endpoints-${chainName}`;
}

export async function getSecretAwsCredentials(agentConfig: AgentContextConfig) {
  return {
    accessKeyId: await fetchGCPSecret(
      `${agentConfig.runEnv}-aws-access-key-id`,
      false,
    ),
    secretAccessKey: await fetchGCPSecret(
      `${agentConfig.runEnv}-aws-secret-access-key`,
      false,
    ),
  };
}

export async function getSecretRpcEndpoints(
  environment: string,
  chainName: ChainName,
): Promise<string[]> {
  const secret = await fetchGCPSecret(getSecretName(environment, chainName));

  if (!Array.isArray(secret)) {
    throw Error(`Expected secret for ${chainName} rpc endpoint`);
  }

  return secret.map((i) => {
    if (typeof i != 'string')
      throw new Error(`Expected string in rpc endpoint array for ${chainName}`);
    return i.trimEnd();
  });
}

export async function getSecretRpcEndpointsLatestVersionName(
  environment: string,
  chainName: ChainName,
) {
  return getGcpSecretLatestVersionName(getSecretName(environment, chainName));
}

export async function secretRpcEndpointsExist(
  environment: string,
  chainName: ChainName,
): Promise<boolean> {
  return gcpSecretExistsUsingClient(getSecretName(environment, chainName));
}

export async function setSecretRpcEndpoints(
  environment: string,
  chainName: ChainName,
  endpoints: string,
) {
  const secretName = getSecretName(environment, chainName);
  await setGCPSecretUsingClient(secretName, endpoints);
}

export async function getSecretDeployerKey(
  environment: DeployEnvironment,
  context: Contexts,
  chainName: ChainName,
) {
  const key = new AgentGCPKey(environment, context, Role.Deployer, chainName);
  await key.fetch();
  return key.privateKey;
}

export async function getCurrentKubernetesContext(): Promise<string> {
  const [stdout] = await execCmd(
    `kubectl config current-context`,
    { encoding: 'utf8' },
    false,
    false,
  );
  return stdout.trimEnd();
}
