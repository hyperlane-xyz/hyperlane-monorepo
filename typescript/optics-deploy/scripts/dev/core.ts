import { deployNChains } from '../../src/core';
import * as alfajores from '../../config/testnets/alfajores';
import * as gorli from '../../config/testnets/gorli';
import * as kovan from '../../config/testnets/kovan';
import * as mumbai from '../../config/testnets/mumbai';
import * as fuji from '../../config/testnets/fuji';
import { updateChainConfigWithKeys, updateCoreConfigWithKeys } from '../../src/agents';
import { CoreDeploy } from '../../src/core/CoreDeploy';

let alfajoresConfig = alfajores.devConfig;
let gorliConfig = gorli.devConfig;
let kovanConfig = kovan.devConfig;
let mumbaiConfig = mumbai.devConfig;
let fujiConfig = fuji.devConfig;

const environment = 'dev';

async function main() {
  const alfajoresDeploy = new CoreDeploy(
    await updateChainConfigWithKeys(environment, alfajores.chain),
    await updateCoreConfigWithKeys(environment, alfajoresConfig)
  );
  const gorliDeploy = new CoreDeploy(
    await updateChainConfigWithKeys(environment, gorli.chain),
    await updateCoreConfigWithKeys(environment, gorliConfig)
  );
  const kovanDeploy = new CoreDeploy(
    await updateChainConfigWithKeys(environment, kovan.chain),
    await updateCoreConfigWithKeys(environment, kovanConfig)
  );
  const mumbaiDeploy = new CoreDeploy(
    await updateChainConfigWithKeys(environment, mumbai.chain),
    await updateCoreConfigWithKeys(environment, mumbaiConfig)
  );
  const fujiDeploy = new CoreDeploy(
    await updateChainConfigWithKeys(environment, fuji.chain),
    await updateCoreConfigWithKeys(environment, fujiConfig)
  );

  await deployNChains([alfajoresDeploy, mumbaiDeploy, fujiDeploy, gorliDeploy, kovanDeploy]);
}

main().then(console.log).catch(console.error)
