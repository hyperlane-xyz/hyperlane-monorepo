import { getArgs, getAgentConfig, getEnvironment } from './utils';
import { KEY_ROLE_ENUM } from '../src/agents';
import { rotateGCPKey } from '../src/agents/gcp';
import { AgentAwsKey } from '../src/agents/aws';
import { DeployEnvironment } from '../src/deploy';
import { ChainName } from '../src/config/chain';

async function rotateKey() {
  const args = await getArgs();
  const argv = await args
    .alias('r', 'role')
    .describe('r', 'key role')
    .choices('r', Object.values(KEY_ROLE_ENUM))
    .require('r')
    .alias('c', 'chain')
    .describe('c', 'chain name')
    .choices('c', Object.values(ChainName))
    .require('c')
    .argv

  const environment = await getEnvironment();
  const agentConfig = await getAgentConfig(environment);

  switch(environment) {
   case DeployEnvironment.dev: {
      await rotateGCPKey(environment, argv.r, argv.c)
      break;
   }
   case DeployEnvironment.mainnet:
   case DeployEnvironment.testnet:
      const key = new AgentAwsKey(
        agentConfig,
        argv.r,
        argv.c
      );
      await key.fetch();
      console.log(`Current key: ${key.address}`);
      await key.rotate();
      console.log(`Key was rotated to ${key.address}. `);
      break;
   default: {
     throw new Error('invalid environment')
      break;
   }
  }
}

rotateKey().then(console.log).catch(console.error);
