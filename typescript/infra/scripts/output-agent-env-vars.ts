import { getAgentEnvVars } from '../src/agents';
import { writeFile } from 'fs/promises';

import {
  getCoreEnvironmentConfig,
  getEnvironment,
  getKeyRoleAndChainArgs,
} from './utils';

async function main() {
  const argv = await getKeyRoleAndChainArgs()
    .alias('f', 'file')
    .string('f')
    .describe('f', 'filepath')
    .require('f').argv;

  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);
  const envVars = await getAgentEnvVars(argv.c, argv.r, config.agent, argv.i);

  await writeFile(argv.f, envVars.join('\n'));
}

main().then(console.log).catch(console.error);
