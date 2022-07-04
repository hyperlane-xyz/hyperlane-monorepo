import { utils } from '@abacus-network/deploy';

import { runAgentHelmCommand } from '../src/agents';
import { HelmCommand } from '../src/utils/helm';

import {
  assertCorrectKubeContext,
  assertEnvironment,
  getCoreEnvironmentConfig,
} from './utils';

async function deploy() {
  const argv = await utils
    .getArgs()
    .alias('c', 'deploy-context')
    .describe('c', 'Deployment context')
    // .default('c', 'abacus')
    .demandOption('c')
    .string('c').argv;

  const environment = assertEnvironment(argv.e as string);
  const config = getCoreEnvironmentConfig(environment);

  const context = argv.c;
  if (!config.agents[context]) {
    throw Error(
      `Invalid context ${context}, must be one of ${Object.keys(
        config.agents,
      )}`,
    );
  }

  const agentConfig = config.agents[context];

  await assertCorrectKubeContext(config);

  // Note the create-keys script should be ran prior to running this script.
  // At the moment, `runAgentHelmCommand` has the side effect of creating keys / users
  // if they do not exist. It's possible for a race condition to occur where creation of
  // a key / user that is used by multiple deployments (like Kathy),
  // whose keys / users are not chain-specific) will be attempted multiple times.
  // While this function still has these side effects, the workaround is to just
  // run the create-keys script first.
  await Promise.all(
    config.agent.chainNames.map((name: any) =>
      runAgentHelmCommand(HelmCommand.InstallOrUpgrade, agentConfig, name),
    ),
  );
}

deploy().then(console.log).catch(console.error);
