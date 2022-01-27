import { devCommunity } from 'optics-multi-provider-community';
import * as alfajores from '../../config/testnets/alfajores';
import * as gorli from '../../config/testnets/gorli';
import * as kovan from '../../config/testnets/kovan';
import * as mumbai from '../../config/testnets/mumbai';
import * as fuji from '../../config/testnets/fuji';
import { checkCoreDeploys, InvariantViolationCollector } from '../../src/checks';
import { configPath } from './agentConfig';
import { makeAllConfigs } from '../../src/config';
import { ethers } from 'ethers';

async function main() {
  devCommunity.registerRpcProvider('alfajores', process.env.ALFAJORES_RPC!)
  devCommunity.registerRpcProvider('gorli', process.env.GORLI_RPC!)
  devCommunity.registerRpcProvider('kovan', process.env.KOVAN_RPC!)
  devCommunity.registerRpcProvider('mumbai', process.env.MUMBAI_RPC!)
  devCommunity.registerRpcProvider('fuji', process.env.FUJI_RPC!)
  devCommunity.registerSigner('alfajores', new ethers.Wallet(process.env.ALFAJORES_DEPLOYER_KEY!))
  const governorDomain = await devCommunity.governorDomain()
  const governorCore = await devCommunity.governorCore()
  const governanceMessages = await governorCore.newGovernanceBatch()

  const invariantViolationCollector = new InvariantViolationCollector()
  await checkCoreDeploys(
    configPath,
    await Promise.all([
      makeAllConfigs(alfajores, (_) => _.devConfig),
      makeAllConfigs(kovan, (_) => _.devConfig),
      makeAllConfigs(gorli, (_) => _.devConfig),
      makeAllConfigs(fuji, (_) => _.devConfig),
      makeAllConfigs(mumbai, (_) => _.devConfig),
    ]),
    governorDomain,
    invariantViolationCollector.handleViolation,
  );

  if (invariantViolationCollector.violations.length === 0) {
    console.info("No upgrades found, exit")
    return
  }

  const violations = invariantViolationCollector.uniqueViolations()
  console.log('checked core deploys, found', violations.length, 'violations')
  for (const violation of violations) {
    const upgrade = await violation.upgradeBeaconController.populateTransaction.upgrade(violation.beaconProxy.beacon.address, violation.expectedImplementationAddress)
    const upgradeCore = await devCommunity.mustGetCore(violation.domain)
    const transferOwnership = await violation.beaconProxy.proxy.populateTransaction.transferOwnership(upgradeCore.governanceRouter.address)
    if (violation.domain === governorDomain) {
      governanceMessages.pushLocal(upgrade)
      governanceMessages.pushLocal(transferOwnership)
    } else {
      governanceMessages.pushRemote(domain, upgrade)
      governanceMessages.pushRemote(domain, transferOwnership)
    }
  }
  const txs = await governanceMessages.build()
  // const receipts = await governanceMessages.execute()
  const receipts = await governanceMessages.estimateGas()
  console.log(receipts)
  governanceMessages.write('../../rust/config/dev-community/', `governance_${Date.now()}.json`, txs)
}
main().then(console.log).catch(console.error)
