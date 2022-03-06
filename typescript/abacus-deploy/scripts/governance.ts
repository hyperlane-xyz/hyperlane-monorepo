import {
  getBridgeDeploy,
  getChainConfigsRecord,
  getCoreDeploy,
  getEnvironment,
  getGovernanceConfig,
  getGovernanceDirectory,
} from './utils';
import { GovernanceDeploy } from '../src/governance';

async function main() {
  const environment = await getEnvironment();
  const chains = await getChainConfigsRecord(environment);
  const config = await getGovernanceConfig(environment);
  const deploy = new GovernanceDeploy();
  await deploy.deploy(chains, config);
  const outputDir = getGovernanceDirectory(environment);
  deploy.writeContracts(outputDir);
  deploy.writeVerificationInput(outputDir);

  const core = await getCoreDeploy(environment);
  await core.transferOwnership(deploy.routerAddresses());

  const bridge = await getBridgeDeploy(environment);
  await bridge.transferOwnership(deploy.routerAddresses());
}

main().then(console.log).catch(console.error);
