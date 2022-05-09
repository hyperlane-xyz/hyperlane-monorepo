import { AbacusCore } from '@abacus-network/sdk';
import { YoDeployer } from '@abacus-network/yo/dist/src/index';

import {
  getCoreEnvironmentConfig,
  getEnvironment,
  getGovernanceContractsSdkFilepath,
  getGovernanceVerificationDirectory,
} from './utils';

async function main() {
  const environment = await getEnvironment();
  const config = await getCoreEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();
  const core = AbacusCore.fromEnvironment(environment, multiProvider);

  const deployer = new YoDeployer(
    // @ts-ignore
    multiProvider,
    // @ts-ignore
    {},
    core,
  );
  const addresses = await deployer.deploy();
  deployer.writeContracts(
    addresses,
    getGovernanceContractsSdkFilepath(environment),
  );
  deployer.writeVerification(getGovernanceVerificationDirectory(environment));
}

main().then(console.log).catch(console.error);
