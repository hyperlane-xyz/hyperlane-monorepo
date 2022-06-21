import { runHelloworldKathyHelmCommand } from '../../src/helloworld-kathy';
import { HelmCommand } from '../../src/utils/helm';
import { getEnvironmentConfig } from '../utils';

import { getHelloWorldConfig } from './utils';

async function main() {
  const config = await getEnvironmentConfig();

  await runHelloworldKathyHelmCommand(
    HelmCommand.InstallOrUpgrade,
    getHelloWorldConfig(config).kathy,
  );
}

main().catch(console.error);
