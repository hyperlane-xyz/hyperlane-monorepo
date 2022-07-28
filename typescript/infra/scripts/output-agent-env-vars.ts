import { getAgentEnvVars } from '../src/agents';
import { writeFile } from 'fs/promises';

import { getContextAgentConfig, getKeyRoleAndChainArgs } from './utils';

async function main() {
  const argv = await getKeyRoleAndChainArgs()
    .alias('f', 'file')
    .string('f')
    .describe('f', 'filepath')
    .require('f').argv;

  const agentConfig = await getContextAgentConfig();
  const envVars = await getAgentEnvVars<any>(
    argv.c,
    argv.r,
    agentConfig,
    argv.i,
  );

  await writeFile(argv.f, envVars.join('\n'));
}

main().then(console.log).catch(console.error);
