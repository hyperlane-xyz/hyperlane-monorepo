import { runHelloworldKathyHelmCommand } from '../../src/helloworld-kathy';
import { HelmCommand } from '../../src/utils/helm';
import { getEnvironmentConfig } from '../utils';

async function main() {
  const config = await getEnvironmentConfig();

  await runHelloworldKathyHelmCommand(
    HelmCommand.InstallOrUpgrade,
    config.agent,
  );
}

main().catch(console.error);
