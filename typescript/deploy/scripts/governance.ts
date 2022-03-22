import { cores, bridges } from '@abacus-network/sdk';
import {
  getEnvironment,
  getGovernanceConfig,
  getGovernanceContractsSdkFilepath,
  getGovernanceVerificationDirectory,
  registerMultiProvider,
} from './utils';
import { AbacusGovernanceDeployer } from '../src/governance';

async function main() {
  const environment = await getEnvironment();
  const core = cores[environment];
  const bridge = bridges[environment];
  registerMultiProvider(core, environment);
  registerMultiProvider(bridge, environment);

  const config = await getGovernanceConfig(environment, core);
  const deployer = new AbacusGovernanceDeployer();
  await registerMultiProvider(deployer, environment);
  await deployer.deploy(config);
  deployer.writeContracts(getGovernanceContractsSdkFilepath(environment));
  deployer.writeVerification(getGovernanceVerificationDirectory(environment));

  await core.transferOwnership(deployer.routerAddresses);
  await bridge.transferOwnership(deployer.routerAddresses);
}

main().then(console.log).catch(console.error);
