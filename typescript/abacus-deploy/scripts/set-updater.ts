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

async function main() {
  const environment = await getEnvironment();
  const context = await getContext(environment);
  const chains = await getChainConfigs(environment);
  registerRpcProviders(context, chains);
  await registerGovernorSigner(context, chains);

  const deploys = await getCoreDeploys(environment);
  const checker = new CoreInvariantChecker(deploys);
  await checker.checkDeploys();
  checker.expectViolations(
    [ViolationType.Validator],
    [chains.length],
  );

  const builder = new GovernanceCallBatchBuilder(
    deploys,
    context,
    checker.violations,
  );
  const batch = await builder.build();

  await batch.build();
  const domains = deploys.map((deploy) => deploy.chain.domain);
  // For each domain, expect one call to set the updater.
  expectCalls(batch, domains, new Array(chains.length).fill(1));
  // Change to `batch.execute` in order to run.
  const receipts = await batch.estimateGas();
  console.log(receipts);
}
main().then(console.log).catch(console.error);
