import { getEnvironment, getCoreDeploy, getGovernanceDeploy, getCoreConfig } from './utils';
import { CoreInvariantChecker } from '../src/core';

async function check() {
  const environment = await getEnvironment();
  const coreDeploy = await getCoreDeploy(environment);
  const governanceDeploy = await getGovernanceDeploy(environment);
  const coreConfig = await getCoreConfig(environment);
  const checker = new CoreInvariantChecker(coreDeploy, coreConfig, governanceDeploy.routerAddresses());
  await checker.check();
  checker.expectEmpty();
}

check().then(console.log).catch(console.error);
