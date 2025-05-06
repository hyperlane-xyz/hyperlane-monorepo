import { join } from 'path';

import { Contexts } from '../../config/contexts.js';
import { getAgentConfig } from '../../scripts/agent-utils.js';
import { getEnvironmentConfig } from '../../scripts/core-utils.js';
import { AgentContextConfig } from '../config/agent/agent.js';
import { DeployEnvironment, EnvironmentConfig } from '../config/environment.js';
import { KeyFunderConfig } from '../config/funding.js';
import { HelmManager } from '../utils/helm.js';
import { getInfraPath } from '../utils/utils.js';

export class KeyFunderHelmManager extends HelmManager {
  readonly helmReleaseName: string = 'key-funder';
  readonly helmChartPath: string = join(getInfraPath(), './helm/key-funder/');

  constructor(
    readonly config: KeyFunderConfig<string[]>,
    readonly agentConfig: AgentContextConfig,
  ) {
    super();
  }

  static forEnvironment(environment: DeployEnvironment): KeyFunderHelmManager {
    const envConfig = getEnvironmentConfig(environment);
    const keyFunderConfig = getKeyFunderConfig(envConfig);
    // Always use Hyperlane context for key funder
    const agentConfig = getAgentConfig(Contexts.Hyperlane, environment);
    return new KeyFunderHelmManager(keyFunderConfig, agentConfig);
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
        // Only used for fetching RPC urls as env vars
        chains: this.agentConfig.environmentChainNames,
        contextFundingFrom: this.config.contextFundingFrom,
        contextsAndRolesToFund: this.config.contextsAndRolesToFund,
        desiredBalancePerChain: this.config.desiredBalancePerChain,
        desiredKathyBalancePerChain: this.config.desiredKathyBalancePerChain,
        igpClaimThresholdPerChain: this.config.igpClaimThresholdPerChain,
        chainsToSkip: this.config.chainsToSkip,
      },
      image: {
        repository: this.config.docker.repo,
        tag: this.config.docker.tag,
      },
      infra: {
        prometheusPushGateway: this.config.prometheusPushGateway,
      },
    };
  }
}

export function getKeyFunderConfig(
  coreConfig: EnvironmentConfig,
): KeyFunderConfig<string[]> {
  const keyFunderConfig = coreConfig.keyFunderConfig;
  if (!keyFunderConfig) {
    throw new Error(
      `Environment ${coreConfig.environment} does not have a KeyFunderConfig config`,
    );
  }
  return keyFunderConfig;
}
