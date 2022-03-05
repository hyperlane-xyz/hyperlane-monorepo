import {
  getKeyRoleAndChainArgs,
  getAgentConfig,
  getEnvironment,
} from './utils';
import { rotateGCPKey } from '../src/agents/gcp';
import { AgentAwsKey } from '../src/agents/aws';
import { DeployEnvironment } from '../src/deploy';

async function rotateKey() {
  const args = await getKeyRoleAndChainArgs();
  const argv = await args.argv;

  const environment = await getEnvironment();
  const agentConfig = await getAgentConfig(environment);

  switch (environment) {
    case DeployEnvironment.dev: {
      await rotateGCPKey(environment, argv.r, argv.c);
      break;
    }
    case DeployEnvironment.testnet:
    case DeployEnvironment.mainnet:
      const key = new AgentAwsKey(agentConfig, argv.r, argv.c);
      await key.fetch();
      console.log(`Current key: ${key.address}`);
      await key.rotate();
      console.log(`Key was rotated to ${key.address}. `);
      break;
    default: {
      throw new Error('invalid environment');
      break;
    }
  }
}

rotateKey().then(console.log).catch(console.error);
