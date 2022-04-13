import { runAgentHelmCommand } from '../src/agents';
import { HelmCommand } from '../src/utils/helm';
import { getEnvironment, getCoreEnvironmentConfig } from './utils';

async function deploy() {
  const environment = await getEnvironment();
  const config = await getCoreEnvironmentConfig(environment);
  for (const name of config.domains) {
    await runAgentHelmCommand(
      HelmCommand.Upgrade,
      config.agent,
      name,
      config.domains,
    );
  }
}

deploy().then(console.log).catch(console.error);
