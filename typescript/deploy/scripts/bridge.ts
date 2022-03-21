import {
  getEnvironment,
  getBridgeConfig,
  getBridgeDirectory,
  registerMultiProvider,
} from './utils';
import { AbacusBridgeDeployer } from '../src/bridge';

async function main() {
  const environment = await getEnvironment();
  const config = await getBridgeConfig(environment);
  const deployer = new AbacusBridgeDeployer();
  await registerMultiProvider(deployer, environment);
  await deployer.deploy(config);
  deployer.writeOutput(getBridgeDirectory(environment));
}

main().then(console.log).catch(console.error);
