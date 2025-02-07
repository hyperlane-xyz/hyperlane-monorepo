import { join } from 'path';

import { Contexts } from '../../config/contexts.js';
import { getAgentConfig } from '../../scripts/agent-utils.js';
import { getEnvironmentConfig } from '../../scripts/core-utils.js';
import { getHelloWorldConfig } from '../../scripts/helloworld/utils.js';
import { AgentAwsUser } from '../agents/aws/user.js';
import { AgentGCPKey } from '../agents/gcp.js';
import { AgentContextConfig } from '../config/agent/agent.js';
import { DeployEnvironment } from '../config/environment.js';
import {
  HelloWorldKathyConfig,
  HelloWorldKathyRunMode,
} from '../config/helloworld/types.js';
import { Role } from '../roles.js';
import {
  HelmCommand,
  HelmCommandOptions,
  HelmManager,
  HelmValues,
  helmifyValues,
} from '../utils/helm.js';
import { execCmd, getInfraPath } from '../utils/utils.js';

export class KathyHelmManager extends HelmManager<HelmValues> {
  readonly helmChartPath: string = join(
    getInfraPath(),
    './helm/helloworld-kathy/',
  );

  constructor(
    readonly config: HelloWorldKathyConfig,
    readonly agentConfig: AgentContextConfig,
  ) {
    super();
  }

  static forEnvironment(
    environment: DeployEnvironment,
    context: Contexts,
  ): KathyHelmManager {
    const envConfig = getEnvironmentConfig(environment);
    const helloWorldConfig = getHelloWorldConfig(envConfig, context);
    const agentConfig = getAgentConfig(Contexts.Hyperlane, environment);
    return new KathyHelmManager(helloWorldConfig.kathy, agentConfig);
  }

  get namespace() {
    return this.config.namespace;
  }

  get helmReleaseName(): string {
    // For backward compatibility, keep the hyperlane context release name as
    // 'helloworld-kathy', and add `-${context}` as a suffix for any other contexts
    return `helloworld-kathy${
      this.agentConfig.context === Contexts.Hyperlane ? '' : `-${context}`
    }`;
  }

  async helmValues(): Promise<HelmValues> {
    const cycleOnce =
      this.config.runConfig.mode === HelloWorldKathyRunMode.CycleOnce;
    const fullCycleTime =
      this.config.runConfig.mode === HelloWorldKathyRunMode.Service
        ? this.config.runConfig.fullCycleTime
        : '';

    return {
      hyperlane: {
        runEnv: this.config.runEnv,
        context: this.agentConfig.context,
        // This is just used for fetching secrets, and is not actually
        // the list of chains that kathy will send to. Because Kathy
        // will fetch secrets for all chains in the environment, regardless
        // of skipping them or not, we pass in all chains
        chains: this.agentConfig.environmentChainNames,
        aws: this.agentConfig.aws !== undefined,

        chainsToSkip: this.config.chainsToSkip,
        messageSendTimeout: this.config.messageSendTimeout,
        messageReceiptTimeout: this.config.messageReceiptTimeout,
        cycleOnce,
        fullCycleTime,
        cyclesBetweenEthereumMessages:
          this.config.cyclesBetweenEthereumMessages,
      },
      image: {
        repository: this.config.docker.repo,
        tag: this.config.docker.tag,
      },
    };
  }

  async runHelmCommand(
    action: HelmCommand,
    options?: HelmCommandOptions,
  ): Promise<void> {
    // If using AWS keys, ensure the Kathy user and key has been created
    if (this.agentConfig.aws) {
      const awsUser = new AgentAwsUser(
        this.agentConfig.runEnv,
        this.agentConfig.context,
        Role.Kathy,
        this.agentConfig.aws.region,
      );
      await awsUser.createIfNotExists();
      await awsUser.createKeyIfNotExists(this.agentConfig);
    }

    // Also ensure a GCP key exists, which is used for non-EVM chains even if
    // the agent config is AWS-based
    const kathyKey = new AgentGCPKey(
      this.agentConfig.runEnv,
      this.agentConfig.context,
      Role.Kathy,
    );
    await kathyKey.createIfNotExists();

    await super.runHelmCommand(action, options);
  }
}
