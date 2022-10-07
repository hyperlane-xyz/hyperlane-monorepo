import { HelmCommand } from '../src/utils/helm';

import {
  assertCorrectKubeContext,
  getContextAgentConfig,
  getCoreEnvironmentConfig,
  getEnvironment,
} from './utils';

async function deploy() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);

  const agentConfig = await getContextAgentConfig(config);

  await assertCorrectKubeContext(config);

  // @ts-ignore
  await runScraperHelmCommand(HelmCommand.InstallOrUpgrade, agentConfig);
}

deploy().then(console.log).catch(console.error);
