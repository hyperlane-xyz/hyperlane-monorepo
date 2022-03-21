import {
  getEnvironment,
  getBridgeConfig,
  getBridgeDirectory,
  registerDeployer,
} from './utils';
import { AbacusBridgeDeployer } from '../src/bridge';

async function main() {
  const environment = await getEnvironment();
  const config = await getBridgeConfig(environment);
  const deployer = new AbacusBridgeDeployer();
  await registerDeployer(deployer, environment);
  await deployer.deploy(config);
  deployer.writeOutput(getBridgeDirectory(environment));
}

main().then(console.log).catch(console.error);
