import { runAgentHelmCommand } from '../src/agents';
import { HelmCommand } from '../src/utils/helm';

import { assertCorrectKubeContext, getEnvironmentConfig } from './utils';

async function deploy() {
  const config = await getEnvironmentConfig();

  await assertCorrectKubeContext(config);

  // Note the create-keys script should be ran prior to running this script.
  // At the moment, `runAgentHelmCommand` has the side effect of creating keys / users
  // if they do not exist. It's possible for a race condition to occur where creation of
  // a key / user that is used by multiple deployments (like Kathy),
  // whose keys / users are not chain-specific) will be attempted multiple times.
  // While this function still has these side effects, the workaround is to just
  // run the create-keys script first.
  await Promise.all(
    config.agent.chainNames.map((name: any) =>
      runAgentHelmCommand(HelmCommand.InstallOrUpgrade, config.agent, name),
    ),
  );
}

deploy().then(console.log).catch(console.error);
