import { getAgentConfig, getDomainNames, getEnvironment } from './utils';
import { runAgentHelmCommand } from '../src/agents';
import { HelmCommand } from '../src/utils/helm';

async function deploy() {
  const environment = await getEnvironment();
  const agentConfig = await getAgentConfig(environment);
  const domainNames = await getDomainNames(environment);
  // await Promise.all(
  //   domainNames.map((name) => {
      return runAgentHelmCommand(
        HelmCommand.Install,
        agentConfig,
        domainNames[0],
        domainNames,
      );
  //   }),
  // );
}

deploy().then(console.log).catch(console.error);
