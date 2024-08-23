import { join } from 'path';

import { Contexts } from '../../config/contexts.js';
import { getAgentConfig } from '../../scripts/agent-utils.js';
import { getEnvironmentConfig } from '../../scripts/core-utils.js';
import { AgentContextConfig } from '../config/agent/agent.js';
import { DeployEnvironment, EnvironmentConfig } from '../config/environment.js';
import { KeyFunderConfig } from '../config/funding.js';
import { HelmCommand, HelmManager, helmifyValues } from '../utils/helm.js';
import { execCmd, getInfraPath } from '../utils/utils.js';

export class KeyFunderHelmManager extends HelmManager<any> {
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

  get dockerImage() {
    return this.config.docker;
  }

  async helmValues(): Promise<any> {
    const values = {
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
      },
      image: {
        repository: this.config.docker.repo,
        tag: this.config.docker.tag,
      },
      infra: {
        prometheusPushGateway: this.config.prometheusPushGateway,
      },
    };
    return helmifyValues(values);
  }
}

// export async function runKeyFunderHelmCommand(
//   helmCommand: HelmCommand,
//   agentConfig: AgentContextConfig,
//   keyFunderConfig: KeyFunderConfig<string[]>,
// ) {
//   const values = getKeyFunderHelmValues(agentConfig, keyFunderConfig);
//   if (helmCommand === HelmCommand.InstallOrUpgrade) {
//     // Delete secrets to avoid them being stale
//     try {
//       await execCmd(
//         `kubectl delete secrets --namespace ${agentConfig.namespace} --selector app.kubernetes.io/instance=key-funder`,
//         {},
//         false,
//         false,
//       );
//     } catch (e) {
//       console.error(e);
//     }
//   }

//   return execCmd(
//     `helm ${helmCommand} key-funder ./helm/key-funder --namespace ${
//       keyFunderConfig.namespace
//     } ${values.join(' ')}`,
//     {},
//     false,
//     true,
//   );
// }

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
