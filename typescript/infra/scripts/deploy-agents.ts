import { runAgentHelmCommand } from '../src/agents';
import { HelmCommand } from '../src/utils/helm';

import { getAgentConfig, getDomainNames, getEnvironment } from './utils';

async function deploy() {
  const environment = await getEnvironment();
  const agentConfig = await getAgentConfig(environment);
  const domainNames = await getDomainNames(environment);

  // Note the create-keys script should be ran prior to running this script.
  // At the moment, `runAgentHelmCommand` has the side effect of creating keys / users
  // if they do not exist. It's possible for a race condition to occur where creation of
  // a key / user that is used by multiple deployments (like Kathy or the Checkpointer,
  // whose keys / users are not chain-specific) will be attempted multiple times.
  // While this function still has these side effects, the workaround is to just
  // run the create-keys script first.
  await Promise.all(
    domainNames.map((name) =>
      runAgentHelmCommand(
        HelmCommand.InstallOrUpgrade,
        agentConfig,
        name,
        domainNames,
      ),
    ),
  );
}

deploy().then(console.log).catch(console.error);
