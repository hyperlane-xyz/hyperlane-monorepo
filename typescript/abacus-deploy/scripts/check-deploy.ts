import { getCoreDeploys, getEnvironment } from './utils';
import { CoreInvariantChecker } from '../src/core/checks';

async function check() {
  const environment = await getEnvironment();
  const coreDeploys = await getCoreDeploys(environment);
  const checker = new CoreInvariantChecker(coreDeploys);
  await checker.checkDeploys();
  checker.expectEmpty();
}

check().then(console.log).catch(console.error);
