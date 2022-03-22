import {
  getKeyRoleAndChainArgs,
  getAgentConfig,
  getEnvironment,
} from './utils';
import { DeployEnvironment } from '../src/config';

async function rotateKey() {
  const args = await getKeyRoleAndChainArgs();
  const argv = await args.argv;

  const environment = await getEnvironment();
  const agentConfig = await getAgentConfig(environment);

  switch (environment) {
    // TODO: re-implement this when the environments actually get readded
    case DeployEnvironment.local: {
      console.log("I don't do anything");
      console.log(argv, agentConfig);
    }
    // case DeployEnvironment.dev: {
    //   await rotateGCPKey(environment, argv.r, argv.c);
    //   break;
    // }
    // case DeployEnvironment.testnet:
    // case DeployEnvironment.mainnet:
    //   const key = new AgentAwsKey(agentConfig, argv.r, argv.c);
    //   await key.fetch();
    //   console.log(`Current key: ${key.address}`);
    //   await key.rotate();
    //   console.log(`Key was rotated to ${key.address}. `);
    //   break;
    // default: {
    //   throw new Error('invalid environment');
    //   break;
    // }
  }
}

rotateKey().then(console.log).catch(console.error);
