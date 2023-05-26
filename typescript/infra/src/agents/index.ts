import { ChainMap, ChainName } from '@hyperlane-xyz/sdk';
import { utils } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts';
import {
  AgentConfig,
  AgentConfigHelper,
  CheckpointSyncerType,
  DeployEnvironment,
  HelmRootAgentValues,
  RelayerConfigHelper,
  ScraperConfigHelper,
  ValidatorConfigHelper,
} from '../config';
import { fetchGCPSecret } from '../utils/gcloud';
import {
  HelmCommand,
  buildHelmChartDependencies,
  helmifyValues,
} from '../utils/helm';
import { execCmd } from '../utils/utils';

import { keyIdentifier, userIdentifier } from './agent';
import { AgentAwsUser, ValidatorAgentAwsUser } from './aws';
import { AgentAwsKey } from './aws/key';
import { AgentGCPKey } from './gcp';
import { fetchKeysForChain } from './key-utils';
import { KeyRole } from './roles';

const HELM_CHART_PATH = '../../rust/helm/hyperlane-agent/';

abstract class AgentHelmManager {
  abstract readonly role: KeyRole;
  abstract readonly helmReleaseName: string;
  readonly helmChartPath: string = HELM_CHART_PATH;
  protected abstract readonly config: AgentConfigHelper;

  get context(): Contexts {
    return this.config.context;
  }

  get environment(): DeployEnvironment {
    return this.config.runEnv;
  }

  get namespace(): string {
    return this.config.namespace;
  }

  abstract readonly keyIdentifier: string;
  abstract readonly userIdentifier: string;

  async runHelmCommand(action: HelmCommand): Promise<void> {
    if (action == HelmCommand.Remove) {
      const cmd = ['helm', action, this.helmReleaseName, this.namespace];
      await execCmd(cmd, {}, false, true);
      return;
    }

    const values = helmifyValues(await this.helmValues());
    if (action == HelmCommand.InstallOrUpgrade) {
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

    const cmd = [
      'helm',
      action,
      this.helmReleaseName,
      this.helmChartPath,
      '--create-namespace',
      '--namespace',
      this.namespace,
      ...values,
    ];
    if (action == HelmCommand.UpgradeDiff) {
      cmd.push(
        `| kubectl diff --namespace ${this.namespace} --field-manager="Go-http-client" -f - || true`,
      );
    }
    await execCmd(cmd, {}, false, true);
  }

  async getEnvVars(valueDict?: HelmRootAgentValues): Promise<string[]> {
    if (!valueDict) valueDict = await this.helmValues();
    const envVars: string[] = [];
    const rpcEndpoints = await this.getSecretRpcEndpoints();
    for (const chain of valueDict.hyperlane.chains) {
      const name = chain.name.toUpperCase();
      const url = rpcEndpoints[chain.name];
      envVars.push(`HYP_BASE_CHAINS_${name}_CONNECTION_URL=${url}`);
    }

    // Base vars from config map
    envVars.push(`HYP_BASE_METRICS=9090`);
    envVars.push(`HYP_BASE_TRACING_LEVEL=info`);
    return envVars;
  }

  async helmValues(): Promise<HelmRootAgentValues> {
    return {
      image: {
        repository: this.config.docker.repo,
        tag: this.config.docker.tag,
      },
      hyperlane: {
        runEnv: this.environment,
        context: this.context,
        aws: !!this.config.aws,
        chains: this.config.environmentChainNames.map((name) => ({
          name,
          disabled: !this.config.contextChainNames.includes(name),
          connection: { type: this.config.connectionType },
        })),
      },
    };
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

  private async getSecretRpcEndpoints(
    quorum = false,
  ): Promise<ChainMap<string>> {
    return Object.fromEntries(
      await Promise.all(
        this.config.contextChainNames.map(async (chainName) => [
          chainName,
          await getSecretRpcEndpoint(this.environment, chainName, quorum),
        ]),
      ),
    );
  }
}

abstract class OmniscientAgentHelmManager extends AgentHelmManager {
  get keyIdentifier(): string {
    return keyIdentifier(this.environment, this.context, this.role);
  }

  get userIdentifier(): string {
    return userIdentifier(this.environment, this.context, this.role);
  }

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
}

export class RelayerHelmManager extends OmniscientAgentHelmManager {
  protected readonly config: RelayerConfigHelper;
  readonly role: KeyRole.Relayer = KeyRole.Relayer;

  constructor(config: AgentConfig) {
    super();
    this.config = new RelayerConfigHelper(config);
  }

  async getEnvVars(): Promise<string[]> {
    const valueDict = await this.helmValues();
    const envVars = await super.getEnvVars(valueDict);
    envVars.push(`HYP_BASE_DB=/tmp/${this.environment}-${this.role}-db`);
    if (!this.config.aws) {
      const gcpKeys = (await fetchKeysForChain(
        this.config,
        this.config.contextChainNames,
      )) as Record<string, AgentGCPKey>;

      const keyId = this.keyIdentifier;
      for (const name of this.config.contextChainNames) {
        envVars.push(
          `HYP_BASE_CHAINS_${name.toUpperCase()}_SIGNER_KEY=${utils.strip0x(
            gcpKeys[keyId].privateKey,
          )}`,
        );
        envVars.push(
          `HYP_BASE_CHAINS_${name.toUpperCase()}_SIGNER_TYPE=hexKey`,
        );
      }
    } else {
      // AWS keys
      const user = new AgentAwsUser(
        this.environment,
        this.context,
        this.role,
        this.config.aws.region,
      );

      const accessKeys = await user.getAccessKeys();

      envVars.push(`AWS_ACCESS_KEY_ID=${accessKeys.accessKeyId}`);
      envVars.push(`AWS_SECRET_ACCESS_KEY=${accessKeys.secretAccessKey}`);

      for (const chainName of this.config.contextChainNames) {
        const key = new AgentAwsKey(this.config.rawConfig, this.role);
        envVars.push(
          ...configEnvVars(
            key.keyConfig,
            `CHAINS_${chainName.toUpperCase()}_SIGNER_`,
          ),
        );
      }
    }

    envVars.push(...configEnvVars(valueDict.hyperlane.relayer?.config ?? {}));
    return envVars;
  }

  async helmValues(): Promise<HelmRootAgentValues> {
    const values = await super.helmValues();
    values.hyperlane.relayer = this.config.isDefined
      ? {
          enabled: true,
          aws: this.config.requiresAwsCredentials,
          config: await this.config.buildConfig(),
        }
      : { enabled: false, aws: false };

    const signers = await this.config.signers();
    values.hyperlane.relayerChains = this.config.environmentChainNames.map(
      (name) => ({
        name,
        signer: signers[name],
      }),
    );

    return values;
  }
}

export class ScraperHelmManager extends OmniscientAgentHelmManager {
  protected readonly config: ScraperConfigHelper;
  readonly role: KeyRole.Scraper = KeyRole.Scraper;

  constructor(config: AgentConfig) {
    super();
    this.config = new ScraperConfigHelper(config);
    if (this.context != Contexts.Hyperlane)
      throw Error('Context does not support scraper');
  }

  async getEnvVars(): Promise<string[]> {
    const valueDict = await this.helmValues();
    const envVars = await super.getEnvVars(valueDict);
    envVars.push(...configEnvVars(valueDict.hyperlane.scraper?.config ?? {}));

    // TODO: this is a secret that needs to be fetched
    envVars.push('HYP_BASE_DB=?TODO?');
    return envVars;
  }

  async helmValues(): Promise<HelmRootAgentValues> {
    const values = await super.helmValues();
    values.hyperlane.scraper = this.config.isDefined
      ? {
          enabled: true,
          config: await this.config.buildConfig(),
        }
      : { enabled: false };
    // scraper never requires aws credentials
    values.hyperlane.aws = false;
    return values;
  }
}

export class ValidatorHelmManager extends MultichainAgentHelmManager {
  protected readonly config: ValidatorConfigHelper;
  readonly role: KeyRole.Validator = KeyRole.Validator;

  constructor(
    config: AgentConfig,
    chainName: ChainName,
    public readonly index: number,
  ) {
    super(chainName);
    this.config = new ValidatorConfigHelper(config, chainName);
    if (!this.config.contextChainNames.includes(chainName))
      throw Error('Context does not support chain');
    if (!this.config.environmentChainNames.includes(chainName))
      throw Error('Environment does not support chain');
    if (this.context != Contexts.Hyperlane)
      throw Error('Context does not support validator');
  }

  get keyIdentifier(): string {
    return keyIdentifier(
      this.environment,
      this.context,
      this.role,
      this.chainName,
      this.index,
    );
  }

  get userIdentifier(): string {
    return userIdentifier(
      this.environment,
      this.context,
      this.role,
      this.chainName,
      this.index,
    );
  }

  async getEnvVars(): Promise<string[]> {
    const valueDict = await this.helmValues();
    const envVars = await super.getEnvVars(valueDict);
    envVars.push(
      `HYP_BASE_DB=/tmp/${this.environment}-${this.role}-${this.chainName}-${this.index}-db`,
    );
    if (!this.config.aws) {
      const gcpKeys = (await fetchKeysForChain(
        this.config.rawConfig,
        this.chainName,
      )) as Record<string, AgentGCPKey>;

      const privateKey = gcpKeys[this.keyIdentifier].privateKey;

      envVars.push(
        `HYP_BASE_VALIDATOR_KEY=${utils.strip0x(privateKey)}`,
        `HYP_BASE_VALIDATOR_TYPE=hexKey`,
      );
    } else {
      // AWS keys
      const checkpointSyncer =
        this.config.validators[this.index].checkpointSyncer;
      if (checkpointSyncer.type != CheckpointSyncerType.S3)
        throw Error(
          'Expected S3 checkpoint syncer for validator with AWS keys',
        );

      const user = new ValidatorAgentAwsUser(
        this.environment,
        this.context,
        this.chainName,
        this.index,
        checkpointSyncer.region,
        checkpointSyncer.bucket,
      );
      const accessKeys = await user.getAccessKeys();
      envVars.push(`AWS_ACCESS_KEY_ID=${accessKeys.accessKeyId}`);
      envVars.push(`AWS_SECRET_ACCESS_KEY=${accessKeys.secretAccessKey}`);
    }

    envVars.push(
      ...configEnvVars(
        (valueDict.hyperlane.validator?.configs ?? [])[this.index] ?? {},
      ),
    );

    return envVars;
  }

  async helmValues(): Promise<HelmRootAgentValues> {
    const helmValues = await super.helmValues();
    helmValues.hyperlane.validator = this.config.isDefined
      ? {
          enabled: true,
          configs: await this.config.buildConfig(),
        }
      : { enabled: false };

    return helmValues;
  }
}

export async function getSecretAwsCredentials(agentConfig: AgentConfig) {
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
    return [secret];
  }

  secret.forEach((i) => {
    if (typeof i != 'string')
      throw new Error(`Expected string in rpc endpoint array for ${chainName}`);
  });

  return secret as string[];
}

export async function getSecretDeployerKey(
  environment: DeployEnvironment,
  context: Contexts,
  chainName: ChainName,
) {
  const key = new AgentGCPKey(
    environment,
    context,
    KeyRole.Deployer,
    chainName,
  );
  await key.fetch();
  return key.privateKey;
}

// Recursively converts a config object into environment variables than can
// be parsed by rust. For example, a config of { foo: { bar: { baz: 420 }, boo: 421 } } will
// be: HYP_FOO_BAR_BAZ=420 and HYP_FOO_BOO=421
function configEnvVars(config: Record<string, any>, key_name_prefix = '') {
  let envVars: string[] = [];
  for (const key of Object.keys(config)) {
    const value = config[key];
    if (typeof value === 'object') {
      envVars = [
        ...envVars,
        ...configEnvVars(value, `${key_name_prefix}${key.toUpperCase()}_`),
      ];
    } else {
      envVars.push(
        `HYP_BASE_${key_name_prefix}${key.toUpperCase()}=${config[key]}`,
      );
    }
  }
  return envVars;
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
