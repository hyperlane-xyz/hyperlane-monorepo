import { ChainName } from '@abacus-network/sdk';

import { runAgentHelmCommand } from '../src/agents';
import { HelmCommand } from '../src/utils/helm';

import { getCoreEnvironmentConfig, getEnvironment } from './utils';

async function deploy() {
  const environment = await getEnvironment();
  const config = await getCoreEnvironmentConfig(environment);
  const domains = Object.keys(config.transactionConfigs) as ChainName[];

  // We intentionally do not Promise.all here to avoid race conditions that could result
  // in attempting to create a user or key multiple times. This was found to happen in
  // situations where agents for different domains would share the same AWS user or
  // AWS KMS key.
  for (const name of domains) {
    await runAgentHelmCommand(
      HelmCommand.InstallOrUpgrade,
      config.agent,
      name,
      domains,
    );
  }
}

deploy().then(console.log).catch(console.error);
