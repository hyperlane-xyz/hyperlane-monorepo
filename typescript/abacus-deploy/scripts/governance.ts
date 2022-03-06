import {
  getBridgeDeploy,
  getChainConfigs,
  getCoreDeploy,
  getEnvironment,
  getGovernanceConfig,
  getGovernanceContractsDirectory,
  getGovernanceVerificationDirectory,
} from './utils';
import { GovernanceDeploy } from '../src/governance';

async function main() {
  const environment = await getEnvironment();
  const chains = await getChainConfigs(environment);
  const config = await getGovernanceConfig(environment);
  const deploy = new GovernanceDeploy();
  await deploy.deploy(chains, config);
  deploy.writeContracts(getGovernanceContractsDirectory(environment));
  deploy.writeVerificationInput(
    getGovernanceVerificationDirectory(environment),
  );

  const core = await getCoreDeploy(environment);
  await core.transferOwnership(deploy.routerAddresses());

  const bridge = await getBridgeDeploy(environment);
  await bridge.transferOwnership(deploy.routerAddresses());
}

main().then(console.log).catch(console.error);
