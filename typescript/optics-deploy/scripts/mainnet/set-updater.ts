import { mainnetCommunity } from 'optics-multi-provider-community';
import { configPath, networks } from './agentConfig';
import { ViolationType } from '../../src/checks';
import { CoreInvariantChecker } from '../../src/core/checks';
import { makeCoreDeploys } from '../../src/core/CoreDeploy';
import { expectCalls, GovernanceCallBatchBuilder } from '../../src/core/govern';

const deploys = makeCoreDeploys(
  configPath,
  networks,
  (_) => _.chain,
  (_) => _.config,
);

async function main() {
  deploys.map(_ => mainnetCommunity.registerRpcProvider(_.chain.name, _.chain.config.rpc))
  const checker = new CoreInvariantChecker(deploys);
  await checker.checkDeploys();
  
  checker.expectViolations(
    [ViolationType.ReplicaUpdater, ViolationType.HomeUpdater],
    [3, 1],
  );

  const builder = new GovernanceCallBatchBuilder(
    deploys,
    mainnetCommunity,
    checker.violations,
  );
  const batch = await builder.build();

  const txs = await batch.build();
  const domains = deploys.map((deploy) => deploy.chain.domain);
  // For each domain, expect one call to set the updater.
  expectCalls(batch, domains, new Array(4).fill(1));
  await batch.estimateGas()
  console.log(txs)
}
main().then(console.log).catch(console.error);
