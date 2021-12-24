import { getPathToLatestDeploy } from '../../src/verification/readDeployOutput';
import { deployCallforwarderRouters } from '../../src/callforwarder';
import * as gorli from '../../config/testnets/gorli';
import * as mumbai from '../../config/testnets/mumbai';
import { CallforwarderDeploy } from '../../src/callforwarder/CallforwarderDeploy';

// get the path to the latest core system deploy
const path = getPathToLatestDeploy();
// const alfajoresDeploy = new CallforwarderDeploy(alfajores.chain, path);
const gorliDeploy = new CallforwarderDeploy(gorli.chain, path);
const mumbaiDeploy = new CallforwarderDeploy(mumbai.chain, path);
// const ropstenDeploy = new BridgeDeploy(ropsten.chain, ropsten.bridgeConfig, path);


deployCallforwarderRouters([gorliDeploy, mumbaiDeploy])
