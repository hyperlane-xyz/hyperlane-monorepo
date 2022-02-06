import { mainnet } from '@abacus-network/sdk';
import { ViolationType } from '../../src/checks';
import { CoreInvariantChecker } from '../../src/core/checks';
import { makeCoreDeploys } from '../../src/core/CoreDeploy';
import { expectCalls, GovernanceCallBatchBuilder } from '../../src/core/govern';
import { core } from '../../config/environments/mainnet/core';
import { chains } from '../../config/environments/mainnet/chains';

const environment = 'mainnet';
const coreDeploys = makeCoreDeploys(environment, chains, core);

async function main() {
  coreDeploys.map((_) =>
    mainnet.registerRpcProvider(_.chainConfig.name, _.chainConfig.json.rpc),
  );
  const checker = new CoreInvariantChecker(coreDeploys);
  await checker.checkDeploys();

  checker.expectViolations(
    [ViolationType.ReplicaUpdater, ViolationType.HomeUpdater],
    [3, 1],
  );

  const builder = new GovernanceCallBatchBuilder(
    coreDeploys,
    mainnet,
    checker.violations,
  );
  const batch = await builder.build();

  const txs = await batch.build();
  const domains = coreDeploys.map((deploy) => deploy.chainConfig.domain);
  // For each domain, expect one call to set the updater.
  expectCalls(batch, domains, new Array(4).fill(1));
  await batch.estimateGas();
  console.log(txs);
}
main().then(console.log).catch(console.error);
