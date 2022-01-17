import { devCommunity } from '@optics-xyz/multi-provider';
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

const alfajoresDeploy = CoreDeploy.fromDirectory('../../rust/config/dev/', alfajores.chain, alfajoresConfig)
const gorliDeploy = CoreDeploy.fromDirectory('../../rust/config/dev/', gorli.chain, gorliConfig)
const kovanDeploy = CoreDeploy.fromDirectory('../../rust/config/dev/', kovan.chain, kovanConfig)
const mumbaiDeploy = CoreDeploy.fromDirectory('../../rust/config/dev/', mumbai.chain, mumbaiConfig)
const fujiDeploy = CoreDeploy.fromDirectory('../../rust/config/dev/', fuji.chain, fujiConfig)

const deploys = [alfajoresDeploy, gorliDeploy, kovanDeploy, mumbaiDeploy, fujiDeploy]
async function main() {
  const governorCore = await devCommunity.governorCore()
  const governorDomain = await devCommunity.governorDomain()
  const governanceMessages = await governorCore.newGovernanceBatch()
  // Nam gets violations here!
  for (const violation: UpgradeBeaconInvariantViolation of violations) {
    const call = await violation.upgradeBeaconController.populateTransaction.upgrade(violation.beacon.address, violation.implementation)
    if (violation.domain === governorDomain) {
      governanceMessages.pushLocal(call)
    } else {
      governanceMessages.pushRemote(violation.domain, call)
    }
  }
  await governanceMessages.build()
  governanceMessages.write('../../rust/config/dev/')
}
main().then(console.log).catch(console.error)
