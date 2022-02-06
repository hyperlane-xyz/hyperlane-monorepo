import { CoreDeploy } from '../../src/core/CoreDeploy';
import { CoreInvariantChecker } from '../../src/core/checks';
import { core } from '../../config/environments/testnet/core';
import { chains } from '../../config/environments/testnet/chains';

const environment = 'testnet';
const directory = `./config/environments/${environment}/contracts`;
const coreDeploys = chains.map((c) => CoreDeploy.fromDirectory(directory, c, core))

async function check() {
  const checker = new CoreInvariantChecker(coreDeploys);
  await checker.checkDeploys();
  checker.expectEmpty();
}

check().then(console.log).catch(console.error);
