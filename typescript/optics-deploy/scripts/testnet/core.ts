import { deployNChains } from '../../src/core';
import { CoreDeploy } from '../../src/core/CoreDeploy';
import { core } from '../../config/environments/testnet/core';
import { chains } from '../../config/environments/testnet/chains';

async function main() {
  const coreDeploys = chains.map((c) => new CoreDeploy(c, core));
  await deployNChains(coreDeploys)
}

main().then(console.log).catch(console.error);
