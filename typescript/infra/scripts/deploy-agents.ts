import { RelayerHelmManager } from '../src/agents';
import { HelmCommand } from '../src/utils/helm';

import { assertCorrectKubeContext, getConfigsBasedOnArgs } from './utils';

async function deploy() {
  const { envConfig, agentConfig } = await getConfigsBasedOnArgs();
  await assertCorrectKubeContext(envConfig);

  // Note the create-keys script should be ran prior to running this script.
  // At the moment, `runAgentHelmCommand` has the side effect of creating keys / users
  // if they do not exist. It's possible for a race condition to occur where creation of
  // a key / user that is used by multiple deployments (like Kathy),
  // whose keys / users are not chain-specific) will be attempted multiple times.
  // While this function still has these side effects, the workaround is to just
  // run the create-keys script first.

  // const chain = agentConfig.contextChainNames[0];
  // await new ValidatorHelmManager(agentConfig, chain).runHelmCommand(
  //   HelmCommand.InstallOrUpgrade,
  // );
  await new RelayerHelmManager(agentConfig).runHelmCommand(
    HelmCommand.InstallOrUpgrade,
  );
  // await new ScraperHelmManager(agentConfig).runHelmCommand(
  //   HelmCommand.InstallOrUpgrade,
  // );

  // await Promise.all(
  //   agentConfig.contextChainNames.map(async (name: string) => {
  //     await new ValidatorHelmManager(agentConfig, name).runHelmCommand(
  //       HelmCommand.InstallOrUpgrade,
  //     );
  //     // await new RelayerHelmManager(agentConfig).runHelmCommand(
  //     //   HelmCommand.InstallOrUpgrade,
  //     // );
  //     // await new ScraperHelmManager(agentConfig).runHelmCommand(
  //     //   HelmCommand.InstallOrUpgrade,
  //     // );
  //   }),
  // );
}

deploy().then(console.log).catch(console.error);
