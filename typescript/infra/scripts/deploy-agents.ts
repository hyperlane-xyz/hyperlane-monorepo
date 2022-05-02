import { runAgentHelmCommand } from '../src/agents';
import { HelmCommand } from '../src/utils/helm';

import { getAgentConfig, getDomainNames, getEnvironment } from './utils';

async function deploy() {
  const environment = await getEnvironment();
  const agentConfig = await getAgentConfig(environment);
  const domainNames = await getDomainNames(environment);

  // We intentionally do not Promise.all here to avoid race conditions that could result
  // in attempting to create a user or key multiple times. This was found to happen in
  // situations where agents for different domains would share the same AWS user or
  // AWS KMS key.
  for (const name of domainNames) {
    await runAgentHelmCommand(
      HelmCommand.InstallOrUpgrade,
      agentConfig,
      name,
      domainNames,
    );
  }
}

deploy().then(console.log).catch(console.error);
