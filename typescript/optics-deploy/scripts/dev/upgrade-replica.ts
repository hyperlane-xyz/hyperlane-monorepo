import { devCommunity } from 'optics-multi-provider-community';
import * as alfajores from '../../config/testnets/alfajores';
import * as gorli from '../../config/testnets/gorli';
import * as kovan from '../../config/testnets/kovan';
import * as mumbai from '../../config/testnets/mumbai';
import * as fuji from '../../config/testnets/fuji';
import { CoreDeploy } from '../../src/core/CoreDeploy';
import { ethers } from 'ethers';
import { ImplementationUpgrader } from '../../src/core/upgrade';
import { writeJSON } from '../../src/utils';

const dir = '../../rust/config/dev-community/';
let alfajoresConfig = alfajores.devConfig;
let gorliConfig = gorli.devConfig;
let kovanConfig = kovan.devConfig;
let mumbaiConfig = mumbai.devConfig;
let fujiConfig = fuji.devConfig;

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
  devCommunity.registerRpcProvider('alfajores', process.env.ALFAJORES_RPC!)
  devCommunity.registerRpcProvider('gorli', process.env.GORLI_RPC!)
  devCommunity.registerRpcProvider('kovan', process.env.KOVAN_RPC!)
  devCommunity.registerRpcProvider('mumbai', process.env.MUMBAI_RPC!)
  devCommunity.registerRpcProvider('fuji', process.env.FUJI_RPC!)
  devCommunity.registerSigner('alfajores', new ethers.Wallet(process.env.ALFAJORES_DEPLOYER_KEY!))

  const upgrader = new ImplementationUpgrader(deploys, devCommunity);
  await upgrader.getInvariantViolations();
  upgrader.expectViolations(['Replica'], [5]);
  const batch = await upgrader.createCallBatch()

  const receipts = await batch.estimateGas()
  console.log(receipts)
  writeJSON('../../rust/config/dev-community/', `governance_${Date.now()}.json`, receipts)
}
main().then(console.log).catch(console.error)
