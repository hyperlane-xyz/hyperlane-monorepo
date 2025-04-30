import { Contexts } from '../../config/contexts.js';
import { AgentContextConfig } from '../../src/config/agent/agent.js';
import { CheckWarpDeployConfig } from '../../src/config/funding.js';
import { HelmCommand, helmifyValues } from '../../src/utils/helm.js';
import { execCmd } from '../../src/utils/utils.js';
import { assertCorrectKubeContext } from '../agent-utils.js';
import { getConfigsBasedOnArgs } from '../core-utils.js';

async function main() {
  const { agentConfig, envConfig } = await getConfigsBasedOnArgs();
  if (agentConfig.context != Contexts.Hyperlane)
    throw new Error(
      `Invalid context ${agentConfig.context}, must be ${Contexts.Hyperlane}`,
    );

  await assertCorrectKubeContext(envConfig);

  if (!envConfig.checkWarpDeployConfig) {
    throw new Error('No checkWarpDeployConfig found');
  }

  await runCheckWarpDeployHelmCommand(
    HelmCommand.InstallOrUpgrade,
    agentConfig,
    envConfig.checkWarpDeployConfig,
  );
}

main()
  .then(() => console.log('Deploy successful!'))
  .catch(console.error);

async function runCheckWarpDeployHelmCommand(
  helmCommand: HelmCommand,
  agentConfig: AgentContextConfig,
  config: CheckWarpDeployConfig,
) {
  const values = getCheckWarpDeployHelmValues(agentConfig, config);

  if (helmCommand === HelmCommand.InstallOrUpgrade) {
    // Delete secrets to avoid them being stale
    try {
      await execCmd(
        `kubectl delete secrets --namespace ${agentConfig.namespace} --selector app.kubernetes.io/instance=check-warp-deploy`,
        {},
        false,
        false,
      );
    } catch (e) {
      console.error(e);
    }
  }

  return execCmd(
    `helm ${helmCommand} check-warp-deploy ./helm/check-warp-deploy --namespace ${
      config.namespace
    } ${values.join(' ')}`,
    {},
    false,
    true,
  );
}

function getCheckWarpDeployHelmValues(
  agentConfig: AgentContextConfig,
  config: CheckWarpDeployConfig,
) {
  const values = {
    cronjob: {
      schedule: config.cronSchedule,
    },
    hyperlane: {
      runEnv: agentConfig.runEnv,
      chains: agentConfig.environmentChainNames,
      registryCommit: config.registryCommit,
    },
    infra: {
      prometheusPushGateway: config.prometheusPushGateway,
    },
    image: {
      repository: config.docker.repo,
      tag: config.docker.tag,
    },
  };
  return helmifyValues(values);
}
