import { ChainName } from '@abacus-network/sdk';
import { runAgentHelmCommand } from '../src/agents';
import { HelmCommand } from '../src/utils/helm';
import { getCoreEnvironmentConfig, getEnvironment } from './utils';

async function deploy() {
  const environment = await getEnvironment();
  const config = await getCoreEnvironmentConfig(environment);
  const domains = Object.keys(config.transactionConfigs) as ChainName[];
  await Promise.all(
    domains.map((name) => {
      return runAgentHelmCommand(
        HelmCommand.InstallOrUpgrade,
        config.agent,
        name,
        domains,
      );
    }),
  );
}

deploy().then(console.log).catch(console.error);
