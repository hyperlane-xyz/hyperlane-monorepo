import {
  getEnvironment,
  getBridgeConfig,
  getBridgeDirectory,
  getChainConfigsRecord,
} from './utils';
import { BridgeDeploy } from '../src/bridge';

async function main() {
  const environment = await getEnvironment();
  const chains = await getChainConfigsRecord(environment);
  const config = await getBridgeConfig(environment);
  const deploy = new BridgeDeploy();
  await deploy.deploy(chains, config);
  deploy.writeOutput(getBridgeDirectory(environment));
}

main().then(console.log).catch(console.error);
