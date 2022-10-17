import { Contexts } from '../config/contexts';
import { runScraperHelmCommand } from '../src/scraper/deploy';
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
  if (agentConfig.context != Contexts.Abacus) {
    // scraper scrapes everything so deploying for multiple contexts might cause unintentional
    // conflicts
    throw new Error(
      `Scraper only supports the '${Contexts.Abacus}' context at this time`,
    );
  }

  await assertCorrectKubeContext(config);

  await runScraperHelmCommand(HelmCommand.InstallOrUpgrade, agentConfig);
}

deploy().then(console.log).catch(console.error);
