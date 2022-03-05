import { getEnvironment, getCoreDeploy, getCoreConfig } from './utils';
import { CoreInvariantChecker } from '../src/core';

async function check() {
  const environment = await getEnvironment();
  const coreDeploy = await getCoreDeploy(environment);
  const coreConfig = await getCoreConfig(environment);
  const checker = new CoreInvariantChecker(coreDeploy, coreConfig);
  await checker.checkDeploy();
  checker.expectEmpty();
}

check().then(console.log).catch(console.error);
