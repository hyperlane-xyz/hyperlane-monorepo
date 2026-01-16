import { join } from 'path';

import { Contexts } from '../../config/contexts.js';
import { getAgentConfig } from '../../scripts/agent-utils.js';
import { getEnvironmentConfig } from '../../scripts/core-utils.js';
import { AgentContextConfig } from '../config/agent/agent.js';
import { DeployEnvironment } from '../config/environment.js';
import { CheckWarpDeployConfig } from '../config/funding.js';
import { HelmManager } from '../utils/helm.js';
import { getInfraPath } from '../utils/utils.js';

export class CheckWarpDeployHelmManager extends HelmManager {
  readonly helmReleaseName: string = 'check-warp-deploy';
  readonly helmChartPath: string = join(
    getInfraPath(),
    './helm/check-warp-deploy/',
  );

  constructor(
    readonly config: CheckWarpDeployConfig,
    readonly agentConfig: AgentContextConfig,
  ) {
    super();
  }

  static forEnvironment(
    environment: DeployEnvironment,
  ): CheckWarpDeployHelmManager | undefined {
    const envConfig = getEnvironmentConfig(environment);
    if (!envConfig.checkWarpDeployConfig) {
      return undefined;
    }
    const agentConfig = getAgentConfig(Contexts.Hyperlane, environment);
    return new CheckWarpDeployHelmManager(
      envConfig.checkWarpDeployConfig,
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
