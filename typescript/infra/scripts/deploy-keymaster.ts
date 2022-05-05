import { runKeymasterHelmCommand } from '../src/agents';
import { HelmCommand } from '../src/utils/helm';
import { getEnvironmentConfig } from './utils';

async function main() {
  const config = await getEnvironmentConfig();
  return runKeymasterHelmCommand(
    HelmCommand.InstallOrUpgrade,
    config.agent,
  );
}

main().then(console.log).catch(console.error);
