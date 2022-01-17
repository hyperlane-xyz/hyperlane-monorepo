import { deployNChains } from '../../src/core';
import * as alfajores from '../../config/testnets/alfajores';
import * as gorli from '../../config/testnets/gorli';
import * as kovan from '../../config/testnets/kovan';
import * as mumbai from '../../config/testnets/mumbai';
import * as fuji from '../../config/testnets/fuji';
import { addDeployerGCPKey, addAgentGCPAddresses } from '../../src/agents';
import { CoreDeploy } from '../../src/core/CoreDeploy';

let alfajoresConfig = alfajores.devConfig;
let gorliConfig = gorli.devConfig;
let kovanConfig = kovan.devConfig;
let mumbaiConfig = mumbai.devConfig;
let fujiConfig = fuji.devConfig;

const environment = 'dev';

async function main() {
  const alfajoresDeploy = new CoreDeploy(
    await addDeployerGCPKey(environment, alfajores.chain),
    await addAgentGCPAddresses(environment, alfajoresConfig)
  );
  const gorliDeploy = new CoreDeploy(
    await addDeployerGCPKey(environment, gorli.chain),
    await addAgentGCPAddresses(environment, gorliConfig)
  );
  const kovanDeploy = new CoreDeploy(
    await addDeployerGCPKey(environment, kovan.chain),
    await addAgentGCPAddresses(environment, kovanConfig)
  );
  const mumbaiDeploy = new CoreDeploy(
    await addDeployerGCPKey(environment, mumbai.chain),
    await addAgentGCPAddresses(environment, mumbaiConfig)
  );
  const fujiDeploy = new CoreDeploy(
    await addDeployerGCPKey(environment, fuji.chain),
    await addAgentGCPAddresses(environment, fujiConfig)
  );

  await deployNChains([alfajoresDeploy, mumbaiDeploy, fujiDeploy, gorliDeploy, kovanDeploy]);
}

main().then(console.log).catch(console.error)
