import { getEnvironment, getCoreEnvironmentConfig } from './utils';
import { runAgentHelmCommand } from '../src/agents';
import { HelmCommand } from '../src/utils/helm';

async function deploy() {
  const environment = await getEnvironment();
  const config = await getCoreEnvironmentConfig(environment);
  await Promise.all(
    config.domains.map((name) => {
      return runAgentHelmCommand(
        HelmCommand.Upgrade,
        config.agent,
        name,
        config.domains,
      );
    }),
  );
}

deploy().then(console.log).catch(console.error);
