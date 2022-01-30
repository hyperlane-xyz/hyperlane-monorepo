import { CoreInvariantChecker } from '../../src/core/checks';
import { configPath, networks } from './agentConfig';
import { makeCoreDeploys } from '../../src/core/CoreDeploy';

const coreDeploys = makeCoreDeploys(
  configPath,
  networks,
  (_) => _.chain,
  (_) => _.devConfig,
);

async function check() {
  const checker = new CoreInvariantChecker(coreDeploys)
  await checker.checkDeploys()
  checker.expectEmpty()
}

check().then(console.log).catch(console.error);
