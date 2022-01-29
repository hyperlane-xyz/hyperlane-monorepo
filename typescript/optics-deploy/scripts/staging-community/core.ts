import { deployNChains } from '../../src/core';
import * as alfajores from '../../config/testnets/alfajores';
import * as gorli from '../../config/testnets/gorli';
import * as kovan from '../../config/testnets/kovan';
import * as ropsten from '../../config/testnets/ropsten';
import { CoreDeploy } from '../../src/core/CoreDeploy';

let alfajoresConfig = alfajores.stagingCommunityConfig;
let gorliConfig = gorli.stagingCommunityConfig;
let kovanConfig = kovan.stagingCommunityConfig;
let ropstenConfig = ropsten.stagingCommunityConfig;

const alfajoresDeploy = new CoreDeploy(alfajores.chain, alfajoresConfig);
const gorliDeploy = new CoreDeploy(gorli.chain, gorliConfig);
const kovanDeploy = new CoreDeploy(kovan.chain, kovanConfig);
const ropstenDeploy = new CoreDeploy(ropsten.chain, ropstenConfig);

deployNChains([ropstenDeploy, gorliDeploy, kovanDeploy, alfajoresDeploy]);
