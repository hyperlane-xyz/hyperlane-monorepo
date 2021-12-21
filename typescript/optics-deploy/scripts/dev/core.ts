import { deployNChains } from '../../src/core';
import * as alfajores from '../../config/testnets/alfajores';
import * as gorli from '../../config/testnets/gorli';
import * as kovan from '../../config/testnets/kovan';
import * as mumbai from '../../config/testnets/mumbai';
import * as fuji from '../../config/testnets/fuji';
import { augmentChain, augmentCoreConfig } from '../../src/agents';
import { CoreDeploy } from '../../src/core/CoreDeploy';

let alfajoresConfig = alfajores.devConfig;
let gorliConfig = gorli.devConfig;
let kovanConfig = kovan.devConfig;
let mumbaiConfig = mumbai.devConfig;
let fujiConfig = fuji.devConfig;

const environment = 'dev';

async function main() {
  const alfajoresDeploy = new CoreDeploy(
    await augmentChain(environment, alfajores.chain),
    await augmentCoreConfig(environment, alfajoresConfig)
  );
  const gorliDeploy = new CoreDeploy(
    await augmentChain(environment, gorli.chain),
    await augmentCoreConfig(environment, gorliConfig)
  );
  const kovanDeploy = new CoreDeploy(
    await augmentChain(environment, kovan.chain),
    await augmentCoreConfig(environment, kovanConfig)
  );
  const mumbaiDeploy = new CoreDeploy(
    await augmentChain(environment, mumbai.chain),
    await augmentCoreConfig(environment, mumbaiConfig)
  );
  const fujiDeploy = new CoreDeploy(
    await augmentChain(environment, fuji.chain),
    await augmentCoreConfig(environment, fujiConfig)
  );

  await deployNChains([alfajoresDeploy, mumbaiDeploy, fujiDeploy, gorliDeploy, kovanDeploy]);
}

main().then(console.log).catch(console.error)
