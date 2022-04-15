import { writeFile } from 'fs/promises';
import { getAgentEnvVars } from '../src/agents';
import {
  getKeyRoleAndChainArgs,
  getAgentConfig,
  getEnvironment,
  getDomainNames,
} from './utils';

async function main() {
  const args = await getKeyRoleAndChainArgs();
  const argv = await args
    .alias('f', 'file')
    .string('f')
    .describe('f', 'filepath')
    .require('f').argv;

  console.log('a')

  const environment = await getEnvironment();
  const agentConfig = await getAgentConfig(environment);
  const domainNames = await getDomainNames(environment);
  console.log('b')
  const envVars = await getAgentEnvVars(
    argv.c,
    argv.r,
    agentConfig,
    domainNames,
  );
  console.log('c')

  await writeFile(argv.f, envVars.join('\n'));
  console.log('d')
}

main().then(console.log).catch(console.error);
