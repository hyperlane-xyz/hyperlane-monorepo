import { runHelloworldKathyHelmCommand } from '../../src/helloworld-kathy';
import { HelmCommand } from '../../src/utils/helm';
import { getEnvironmentConfig } from '../utils';

async function main() {
  const coreConfig = await getEnvironmentConfig();

  await runHelloworldKathyHelmCommand(HelmCommand.InstallOrUpgrade, coreConfig);
}

main().catch(console.error);
