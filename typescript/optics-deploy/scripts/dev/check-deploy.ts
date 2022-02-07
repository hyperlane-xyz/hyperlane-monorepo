import { makeCoreDeploys } from '../../src/core/CoreDeploy';
import { CoreInvariantChecker } from '../../src/core/checks';
import { core } from '../../config/environments/dev/core';
import { chains } from '../../config/environments/dev/chains';

const environment = 'dev';
const coreDeploys = makeCoreDeploys(environment, chains, core);

async function check() {
  const checker = new CoreInvariantChecker(coreDeploys);
  await checker.checkDeploys();
  checker.expectEmpty();
}

check().then(console.log).catch(console.error);
