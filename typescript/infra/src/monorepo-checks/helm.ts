import { join } from 'path';

import { Contexts } from '../../config/contexts.js';
import { getAgentConfig } from '../../scripts/agent-utils.js';
import { getEnvironmentConfig } from '../../scripts/core-utils.js';
import { AgentContextConfig } from '../config/agent/agent.js';
import { DeployEnvironment } from '../config/deploy-environment.js';
import { MonorepoChecksConfig } from '../config/funding.js';
import { HelmManager } from '../utils/helm.js';
import { getInfraPath } from '../utils/utils.js';

export class MonorepoChecksHelmManager extends HelmManager {
  // Retains the legacy release name so this deploys as an in-place upgrade of
  // the existing check-warp-deploy release (reusing its synced env secret)
  // rather than a new release requiring a fresh secret sync + old-release teardown.
  readonly helmReleaseName: string = 'check-warp-deploy';
  readonly helmChartPath: string = join(
    getInfraPath(),
    './helm/monorepo-checks/',
  );

  constructor(
    readonly config: MonorepoChecksConfig,
    readonly agentConfig: AgentContextConfig,
  ) {
    super();
  }

  static forEnvironment(
    environment: DeployEnvironment,
  ): MonorepoChecksHelmManager | undefined {
    const envConfig = getEnvironmentConfig(environment);
    if (!envConfig.monorepoChecksConfig) {
      return undefined;
    }
    const agentConfig = getAgentConfig(Contexts.Hyperlane, environment);
    return new MonorepoChecksHelmManager(
      envConfig.monorepoChecksConfig,
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
        chains: this.agentConfig.environmentChainNames,
        checks: this.config.checks,
        registryCommit: this.config.registryCommit,
        runEnv: this.agentConfig.runEnv,
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
