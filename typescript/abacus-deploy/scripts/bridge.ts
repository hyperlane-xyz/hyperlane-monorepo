import {
  getEnvironment,
  getBridgeConfigRecord,
  getBridgeDirectory,
  getChainConfigs,
} from './utils';
import { BridgeDeploy } from '../src/bridge';

async function main() {
  const environment = await getEnvironment();
  const chains = await getChainConfigsRecord(environment);
  const config = await getBridgeConfig(environment);
  const deploy = new BridgeDeploy();
  await deploy.deploy(chains, config);
  const outputDir = getBridgeDirectory(environment);
  deploy.writeContracts(outputDir);
  deploy.writeVerificationInput(outputDir);
}

main().then(console.log).catch(console.error);
