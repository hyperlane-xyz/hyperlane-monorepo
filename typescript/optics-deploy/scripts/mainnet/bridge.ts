import { getPathToLatestDeploy } from '../../src/verification/readDeployOutput';
import { deployBridges } from '../../src/bridge';
import * as celo from '../../config/networks/mainnets/celo';
import * as ethereum from '../../config/networks/mainnets/ethereum';
import * as polygon from '../../config/networks/mainnets/polygon';
import * as avalanche from '../../config/networks/mainnets/avalanche';
import { BridgeDeploy } from '../../src/bridge/BridgeDeploy';

// get the path to the latest core system deploy
const path = getPathToLatestDeploy();

const celoDeploy = new BridgeDeploy(celo.chain, celo.bridgeConfig, path);
const ethereumDeploy = new BridgeDeploy(
  ethereum.chain,
  ethereum.bridgeConfig,
  path,
);

const polygonDeploy = new BridgeDeploy(
  polygon.chain,
  polygon.bridgeConfig,
  path,
);
const avalancheDeploy = new BridgeDeploy(
  avalanche.chain,
  avalanche.bridgeConfig,
  path,
);

deployBridges([celoDeploy, ethereumDeploy, polygonDeploy, avalancheDeploy]);
