import { writeFile } from 'fs/promises';
import { getAgentEnvVars } from '../src/agents';
import { getKeyRoleAndChainArgs, getAgentConfig, getEnvironment, getChainConfigs } from './utils';

async function main() {
  const args = await getKeyRoleAndChainArgs();
  const argv = await args
    .alias('f', 'file')
    .string('f')
    .describe('f', 'filepath')
    .require('f')
    .argv

  const environment = await getEnvironment();
  const agentConfig = await getAgentConfig(environment);
  const chains = await getChainConfigs(environment);
  const envVars = await getAgentEnvVars(argv.c, argv.r, agentConfig, chains);

  await writeFile(argv.f, envVars.join('\n'));
}

main().then(console.log).catch(console.error);
