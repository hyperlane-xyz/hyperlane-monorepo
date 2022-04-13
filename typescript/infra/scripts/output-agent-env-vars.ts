import { writeFile } from 'fs/promises';
import { getAgentEnvVars } from '../src/agents';
import {
  getEnvironment,
  getCoreEnvironmentConfig,
  getKeyRoleAndChainArgs,
} from './utils';

async function main() {
  const args = await getKeyRoleAndChainArgs();
  const argv = await args
    .alias('f', 'file')
    .string('f')
    .describe('f', 'filepath')
    .require('f').argv;

  const environment = await getEnvironment();
  const config = await getCoreEnvironmentConfig(environment);
  const envVars = await getAgentEnvVars(
    argv.c,
    argv.r,
    config.agent,
    config.domains,
  );

  await writeFile(argv.f, envVars.join('\n'));
}

main().then(console.log).catch(console.error);
