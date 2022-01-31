import { stagingCommunity } from 'optics-multi-provider-community';
import { ethers } from 'ethers';
import { configPath, networks } from './agentConfig';
import { ViolationType } from '../../src/checks';
import { CoreInvariantChecker } from '../../src/core/checks';
import { makeCoreDeploys } from '../../src/core/CoreDeploy';
import { expectCalls, GovernanceCallBatchBuilder } from '../../src/core/govern';

const deploys = makeCoreDeploys(
  configPath,
  networks,
  (_) => _.chain,
  (_) => _.stagingConfig,
);

async function main() {
  stagingCommunity.registerRpcProvider('ropsten', process.env.ROPSTEN_RPC!)
  stagingCommunity.registerRpcProvider('gorli', process.env.GORLI_RPC!)
  stagingCommunity.registerRpcProvider('kovan', process.env.KOVAN_RPC!)
  stagingCommunity.registerRpcProvider('alfajores', process.env.ALFAJORES_RPC!)
  stagingCommunity.registerSigner('ropsten', new ethers.Wallet(process.env.ROPSTEN_DEPLOYER_KEY!))

  const checker = new CoreInvariantChecker(deploys);
  await checker.checkDeploys();
  checker.expectViolations([ViolationType.ReplicaUpdater, ViolationType.HomeUpdater ], [4, 1])
  const builder = new GovernanceCallBatchBuilder(deploys, stagingCommunity, checker.violations);
  const batch = await builder.build()

  await batch.build()
  const domains = deploys.map((deploy) => deploy.chain.domain)
  // For each domain, expect one call to set the updater.
  expectCalls(batch, domains, new Array(5).fill(1))
  // Change to `batch.execute` in order to run.
  const receipts = await batch.execute()
  console.log(receipts)
}
main().then(console.log).catch(console.error)
