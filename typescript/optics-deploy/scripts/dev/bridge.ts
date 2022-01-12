import { deployBridges } from '../../src/bridge';
import * as alfajores from '../../config/testnets/alfajores';
import * as gorli from '../../config/testnets/gorli';
import * as kovan from '../../config/testnets/kovan';
import * as mumbai from '../../config/testnets/mumbai';
import * as fuji from '../../config/testnets/fuji';
import { updateChainConfigWithKeys } from '../../src/agents';
import { BridgeDeploy } from '../../src/bridge/BridgeDeploy';
import { getPathToLatestDeploy } from '../../src/verification/readDeployOutput';

let alfajoresConfig = alfajores.bridgeConfig;
let gorliConfig = gorli.bridgeConfig;
let kovanConfig = kovan.bridgeConfig;
let mumbaiConfig = mumbai.bridgeConfig;
let fujiConfig = fuji.bridgeConfig;

const environment = 'dev';

async function main() {
  const path = getPathToLatestDeploy();

  const alfajoresDeploy = new BridgeDeploy(
    await updateChainConfigWithKeys(environment, alfajores.chain),
    alfajoresConfig,
    path
  );
  const gorliDeploy = new BridgeDeploy(
    await updateChainConfigWithKeys(environment, gorli.chain),
    gorliConfig,
    path
  );
  const kovanDeploy = new BridgeDeploy(
    await updateChainConfigWithKeys(environment, kovan.chain),
    kovanConfig,
    path
  );
  const mumbaiDeploy = new BridgeDeploy(
    await updateChainConfigWithKeys(environment, mumbai.chain),
    mumbaiConfig,
    path
  );
  const fujiDeploy = new BridgeDeploy(
    await updateChainConfigWithKeys(environment, fuji.chain),
    fujiConfig,
    path
  );

  await deployBridges([alfajoresDeploy, mumbaiDeploy, fujiDeploy, gorliDeploy, kovanDeploy]);
}

main().then(console.log).catch(console.error)

