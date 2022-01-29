import { devCommunity } from 'optics-multi-provider-community';
import { ethers } from 'ethers';
import { expectCalls, ImplementationUpgrader } from '../../src/core/upgrade';
import { writeJSON } from '../../src/utils';
import { Call } from 'optics-multi-provider-community/dist/optics/govern';
import { configPath, networks } from './agentConfig';
import { makeCoreDeploys, CoreDeploy } from '../../src/core/CoreDeploy';

const deploys = makeCoreDeploys(
  configPath,
  networks,
  (_) => _.chain,
  (_) => _.devConfig,
);

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

  const domains = deploys.map((d: CoreDeploy) => d.chain.domain)
  for (const home of domains) {
    for (const remote of domains) {
      if (home === remote) continue;
      const core = devCommunity.mustGetCore(remote)
      const replica = core.getReplica(home)
      const transferOwnership = await replica!.populateTransaction.transferOwnership(core._governanceRouter)
      batch.push(remote, transferOwnership as Call)
    }
  }

  await batch.build()
  // For each domain, expect one call to upgrade the contract and then four
  // calls to transfer replica ownership.
  expectCalls(batch, domains, new Array(5).fill(5))
  const receipts = await batch.execute()
  // const receipts = await batch.estimateGas()
  console.log(receipts)
  writeJSON('../../rust/config/dev-community/', `governance_${Date.now()}.json`, receipts)
}
main().then(console.log).catch(console.error)
