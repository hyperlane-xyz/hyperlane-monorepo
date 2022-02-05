import { deployNChains } from '../../src/core';
import * as alfajores from '../../config/networks/testnets/alfajores';
import * as gorli from '../../config/networks/testnets/gorli';
import * as kovan from '../../config/networks/testnets/kovan';
import * as ropsten from '../../config/networks/testnets/ropsten';
import { CoreDeploy } from '../../src/core/CoreDeploy';

let alfajoresConfig = alfajores.testnetConfig;
let gorliConfig = gorli.testnetConfig;
let kovanConfig = kovan.testnetConfig;
let ropstenConfig = ropsten.testnetConfig;

const alfajoresDeploy = new CoreDeploy(alfajores.chain, alfajoresConfig);
const gorliDeploy = new CoreDeploy(gorli.chain, gorliConfig);
const kovanDeploy = new CoreDeploy(kovan.chain, kovanConfig);
const ropstenDeploy = new CoreDeploy(ropsten.chain, ropstenConfig);

deployNChains([ropstenDeploy, gorliDeploy, kovanDeploy, alfajoresDeploy]);
