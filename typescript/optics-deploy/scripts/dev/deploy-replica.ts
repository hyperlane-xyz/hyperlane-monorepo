import { ImplementationDeployer } from '../../src/core/implementation';
import * as alfajores from '../../config/testnets/alfajores';
import * as gorli from '../../config/testnets/gorli';
import * as kovan from '../../config/testnets/kovan';
import * as mumbai from '../../config/testnets/mumbai';
import * as fuji from '../../config/testnets/fuji';
import { CoreDeploy } from '../../src/core/CoreDeploy';

let alfajoresConfig = alfajores.devConfig;
let gorliConfig = gorli.devConfig;
let kovanConfig = kovan.devConfig;
let mumbaiConfig = mumbai.devConfig;
let fujiConfig = fuji.devConfig;

const dir = '../../rust/config/dev-community/';
const alfajoresDeploy = CoreDeploy.fromDirectory(
  dir,
  alfajores.chain,
  alfajoresConfig,
);
const gorliDeploy = CoreDeploy.fromDirectory(dir, gorli.chain, gorliConfig);
const kovanDeploy = CoreDeploy.fromDirectory(dir, kovan.chain, kovanConfig);
const mumbaiDeploy = CoreDeploy.fromDirectory(dir, mumbai.chain, mumbaiConfig);
const fujiDeploy = CoreDeploy.fromDirectory(dir, fuji.chain, fujiConfig);

const deploys = [
  alfajoresDeploy,
  mumbaiDeploy,
  fujiDeploy,
  gorliDeploy,
  kovanDeploy,
];

async function main() {
  const deployer = new ImplementationDeployer(deploys);
  await deployer.deployReplicaImplementations();
  deployer.writeDeployOutput(dir)
}
main().then(console.log).catch(console.error);

