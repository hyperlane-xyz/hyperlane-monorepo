import {
  getKeyRoleAndChainArgs,
  getAgentConfig,
  getEnvironment,
} from './utils';
import { AgentAwsKey } from '../src/agents/aws';

async function rotateKey() {
  const args = await getKeyRoleAndChainArgs();
  const argv = await args.argv;

  const environment = await getEnvironment();
  const agentConfig = await getAgentConfig(environment);

  switch (environment) {
    case 'testnet':
    case 'mainnet':
      const key = new AgentAwsKey(agentConfig, argv.r, argv.c);
      await key.fetch();
      console.log(`Current key: ${key.address}`);
      await key.update();
      console.log(`Create new key with address: ${key.address}`);
      console.log('Run rotate-key script to rotate the key via the alias.');
      break;
    default: {
      throw new Error('invalid environment');
      break;
    }
  }
}

rotateKey().then(console.log).catch(console.error);
