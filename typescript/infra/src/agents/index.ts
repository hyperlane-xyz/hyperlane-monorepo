import fs from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { ChainName, RpcConsensusType, chainMetadata } from '@hyperlane-xyz/sdk';

import { Contexts } from '../../config/contexts.js';
import {
  AgentConfigHelper,
  AgentContextConfig,
  DockerConfig,
  HelmRootAgentValues,
  RootAgentConfig,
} from '../config/agent/agent.js';
import { RelayerConfigHelper } from '../config/agent/relayer.js';
import { ScraperConfigHelper } from '../config/agent/scraper.js';
import { ValidatorConfigHelper } from '../config/agent/validator.js';
import { DeployEnvironment } from '../config/environment.js';
import { AgentRole, Role } from '../roles.js';
import { fetchGCPSecret } from '../utils/gcloud.js';
import {
  HelmCommand,
  buildHelmChartDependencies,
  helmifyValues,
} from '../utils/helm.js';
import { execCmd, isEthereumProtocolChain } from '../utils/utils.js';

import { AgentGCPKey } from './gcp.js';

const HELM_CHART_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '/../../../../rust/helm/hyperlane-agent/',
);

if (!fs.existsSync(HELM_CHART_PATH + 'Chart.yaml'))
  console.warn(
    `Could not find helm chart at ${HELM_CHART_PATH}; the relative path may have changed.`,
  );

export abstract class AgentHelmManager {
  abstract readonly role: AgentRole;
  abstract readonly helmReleaseName: string;
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

  async runHelmCommand(action: HelmCommand, dryRun?: boolean): Promise<void> {
    const cmd = ['helm', action];
    if (dryRun) cmd.push('--dry-run');

    if (action == HelmCommand.Remove) {
      if (dryRun) cmd.push('--dry-run');
      cmd.push(this.helmReleaseName, this.namespace);
      await execCmd(cmd, {}, false, true);
      return;
    }

    const values = helmifyValues(await this.helmValues());
    if (action == HelmCommand.InstallOrUpgrade && !dryRun) {
      // Delete secrets to avoid them being stale
      const cmd = [
        'kubectl',
        'delete',
        'secrets',
        '--namespace',
        this.namespace,
        '--selector',
        `app.kubernetes.io/instance=${this.helmReleaseName}`,
      ];
      try {
        await execCmd(cmd, {}, false, false);
      } catch (e) {
        console.error(e);
      }
    }

    await buildHelmChartDependencies(this.helmChartPath);
    cmd.push(
      this.helmReleaseName,
      this.helmChartPath,
      '--create-namespace',
      '--namespace',
      this.namespace,
      ...values,
    );
    if (action == HelmCommand.UpgradeDiff) {
      cmd.push(
        `| kubectl diff --namespace ${this.namespace} --field-manager="Go-http-client" -f - || true`,
      );
    }
    await execCmd(cmd, {}, false, true);
  }

  async helmValues(): Promise<HelmRootAgentValues> {
    const dockerImage = this.dockerImage();
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
          const metadata = chainMetadata[chain];
          const reorgPeriod = metadata.blocks?.reorgPeriod;
          if (reorgPeriod === undefined) {
            throw new Error(`No reorg period found for chain ${chain}`);
          }
          return {
            name: chain,
            rpcConsensusType: this.rpcConsensusType(chain),
            protocol: metadata.protocol,
            blocks: { reorgPeriod },
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

    return this.config.rpcConsensusType;
  }

  async doesAgentReleaseExist() {
    try {
      await execCmd(
        `helm status ${this.helmReleaseName} --namespace ${this.namespace}`,
        {},
        false,
        false,
      );
      return true;
    } catch (error) {
      return false;
    }
  }

  dockerImage(): DockerConfig {
    return this.config.docker;
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

  dockerImage(): DockerConfig {
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
    values.hyperlane.relayer = {
      enabled: true,
      aws: this.config.requiresAwsCredentials,
      config: await this.config.buildConfig(),
    };

    const signers = await this.config.signers();
    values.hyperlane.relayerChains = this.config.relayChains.map((name) => ({
      name,
      signer: signers[name],
    }));

    return values;
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

    helmValues.hyperlane.validator = {
      enabled: true,
      configs: cfg.validators.map((c) => ({
        ...c,
        originChainName: cfg.originChainName,
        interval: cfg.interval,
      })),
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

export async function getSecretRpcEndpoint(
  environment: string,
  chainName: ChainName,
  quorum = false,
): Promise<string[]> {
  const secret = await fetchGCPSecret(
    `${environment}-rpc-endpoint${quorum ? 's' : ''}-${chainName}`,
    quorum,
  );
  if (typeof secret != 'string' && !Array.isArray(secret)) {
    throw Error(`Expected secret for ${chainName} rpc endpoint`);
  }
  if (!Array.isArray(secret)) {
    return [secret.trimEnd()];
  }

  return secret.map((i) => {
    if (typeof i != 'string')
      throw new Error(`Expected string in rpc endpoint array for ${chainName}`);
    return i.trimEnd();
  });
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
