import { AbacusCore, coreAddresses } from '@abacus-network/sdk';
import {
  getEnvironment,
  getBridgeConfig,
  getBridgeContractsSdkFilepath,
  getBridgeVerificationDirectory,
  registerMultiProvider,
} from './utils';
import { AbacusBridgeDeployer } from '../src/bridge';

async function main() {
  const environment = await getEnvironment();
  const config = await getBridgeConfig(
    environment,
    new AbacusCore(coreAddresses[environment]),
  );
  const deployer = new AbacusBridgeDeployer();
  await registerMultiProvider(deployer, environment);
  await deployer.deploy(config);
  deployer.writeContracts(getBridgeContractsSdkFilepath(environment));
  deployer.writeVerification(getBridgeVerificationDirectory(environment));
}

main().then(console.log).catch(console.error);
