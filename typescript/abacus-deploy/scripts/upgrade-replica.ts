import {
  getCoreDeploys,
  getChainConfigs,
  getContext,
  getEnvironment,
  registerRpcProviders,
  registerGovernorSigner,
} from './utils';
import { ViolationType } from '../src/checks';
import { CoreInvariantChecker } from '../src/core/checks';
import { expectCalls, GovernanceCallBatchBuilder } from '../src/core/govern';
import { Call } from '@abacus-network/sdk/dist/abacus/govern';

async function main() {
  const environment = await getEnvironment();
  const context = await getContext(environment);
  const chains = await getChainConfigs(environment);
  registerRpcProviders(context, chains);
  await registerGovernorSigner(context, chains);

  const deploys = await getCoreDeploys(environment);
  const checker = new CoreInvariantChecker(deploys);
  await checker.checkDeploys();
  checker.expectViolations([ViolationType.UpgradeBeacon], [chains.length]);
  const builder = new GovernanceCallBatchBuilder(
    deploys,
    context,
    checker.violations,
  );
  const batch = await builder.build();

  const domains = deploys.map((d) => d.chain.domain);
  for (const outbox of domains) {
    for (const remote of domains) {
      if (outbox === remote) continue;
      const core = context.mustGetCore(remote);
      const inbox = core.getInbox(outbox);
      const transferOwnership =
        await inbox!.populateTransaction.transferOwnership(
          core._governanceRouter,
        );
      batch.push(remote, transferOwnership as Call);
    }
  }

  const txs = await batch.build();
  // For each domain, expect one call to upgrade the contract and then three
  // calls to transfer inbox ownership.
  expectCalls(batch, domains, new Array(chains.length).fill(chains.length));
  // Change to `batch.execute` in order to run.
  const receipts = await batch.estimateGas();
  console.log(txs);
  console.log(receipts);
}
main().then(console.log).catch(console.error);
