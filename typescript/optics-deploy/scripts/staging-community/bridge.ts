import { getPathToLatestDeploy } from '../../src/verification/readDeployOutput';
import { deployBridges } from '../../src/bridge';
import * as alfajores from '../../config/testnets/alfajores';
import * as gorli from '../../config/testnets/gorli';
import * as kovan from '../../config/testnets/kovan';
import * as ropsten from '../../config/testnets/ropsten';
import { BridgeDeploy } from '../../src/bridge/BridgeDeploy';

// get the path to the latest core system deploy
const path = getPathToLatestDeploy();

const alfajoresDeploy = new BridgeDeploy(
  alfajores.chain,
  alfajores.bridgeConfig,
  path,
);
const gorliDeploy = new BridgeDeploy(gorli.chain, gorli.bridgeConfig, path);
const kovanDeploy = new BridgeDeploy(kovan.chain, kovan.bridgeConfig, path);
const ropstenDeploy = new BridgeDeploy(
  ropsten.chain,
  ropsten.bridgeConfig,
  path,
);

deployBridges([alfajoresDeploy, gorliDeploy, kovanDeploy, ropstenDeploy]);
