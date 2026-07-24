import { join } from 'path';

import { Contexts } from '../../config/contexts.js';
import { getAgentConfig } from '../../scripts/agent-utils.js';
import { getEnvironmentConfig } from '../../scripts/core-utils.js';
import { AgentContextConfig } from '../config/agent/agent.js';
import { DeployEnvironment } from '../config/deploy-environment.js';
import { ValidatorMonitorConfig } from '../config/funding.js';
import { HelmManager } from '../utils/helm.js';
import { getInfraPath } from '../utils/utils.js';

export class ValidatorMonitorHelmManager extends HelmManager {
  readonly helmReleaseName: string = 'validator-monitor';
  readonly helmChartPath: string = join(
    getInfraPath(),
    './helm/validator-monitor/',
  );

  constructor(
    readonly config: ValidatorMonitorConfig,
    readonly agentConfig: AgentContextConfig,
  ) {
    super();
  }

  static forEnvironment(
    environment: DeployEnvironment,
  ): ValidatorMonitorHelmManager | undefined {
    const envConfig = getEnvironmentConfig(environment);
    if (!envConfig.validatorMonitorConfig) {
      return undefined;
    }
    const agentConfig = getAgentConfig(Contexts.Hyperlane, environment);
    return new ValidatorMonitorHelmManager(
      envConfig.validatorMonitorConfig,
      agentConfig,
    );
  }

  get namespace() {
    return this.config.namespace;
  }

  async helmValues() {
    return {
      cronjob: {
        schedule: this.config.cronSchedule,
      },
      hyperlane: {
        runEnv: this.agentConfig.runEnv,
        chains: this.agentConfig.environmentChainNames,
        registryCommit: this.config.registryCommit,
      },
      infra: {
        prometheusPushGateway: this.config.prometheusPushGateway,
      },
      image: {
        repository: this.config.docker.repo,
        tag: this.config.docker.tag,
      },
    };
  }
}
