import { runKeymasterHelmCommand } from '../src/agents';
import { HelmCommand } from '../src/utils/helm';
import { getEnvironment, getCoreEnvironmentConfig } from './utils';

async function main() {
  const environment = await getEnvironment();
  const config = await getCoreEnvironmentConfig(environment);
  return runKeymasterHelmCommand(
    HelmCommand.Install,
    config.agent,
    config.domains,
  );
}

main().then(console.log).catch(console.error);
