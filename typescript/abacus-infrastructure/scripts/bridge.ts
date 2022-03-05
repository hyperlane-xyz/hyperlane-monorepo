import {
  getEnvironment,
  getBridgeConfig,
  getBridgeContractsDirectory,
  getChainConfigs,
} from './utils';
import { BridgeDeploy } from '../src/bridge/BridgeDeploy';

async function main() {
  const environment = await getEnvironment();
  const chains = await getChainConfigs(environment);
  const config = await getBridgeConfig(environment);
  const deploy = new BridgeDeploy();
  await deploy.deploy(chains, config);
  deploy.writeContracts(getBridgeContractsDirectory(environment));
}

main().then(console.log).catch(console.error);
