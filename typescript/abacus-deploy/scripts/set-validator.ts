import {
  getCoreDeploy,
  getCoreConfig,
  getChainConfigs,
  getContext,
  getEnvironment,
  getGovernanceDeploy,
  registerRpcProviders,
  registerGovernorSigner,
} from './utils';
import { ViolationType } from '../src/common';
import { CoreInvariantChecker } from '../src/core';
import { expectCalls, GovernanceCallBatchBuilder } from '../src/core/govern';

async function main() {
  const environment = await getEnvironment();
  const context = await getContext(environment);
  const chains = await getChainConfigs(environment);
  registerRpcProviders(context, chains);
  await registerGovernorSigner(context, chains);

  const deploy = await getCoreDeploy(environment);
  const governance = await getGovernanceDeploy(environment);
  const config = await getCoreConfig(environment);
  const checker = new CoreInvariantChecker(
    deploy,
    config,
    governance.routerAddresses(),
  );
  await checker.check();
  checker.expectViolations([ViolationType.Validator], [chains.length]);

  const builder = new GovernanceCallBatchBuilder(
    deploy,
    context,
    checker.violations,
  );
  const batch = await builder.build();

  await batch.build();
  // For each domain, expect one call to set the updater.
  expectCalls(batch, deploy.domains, new Array(chains.length).fill(1));
  // Change to `batch.execute` in order to run.
  const receipts = await batch.estimateGas();
  console.log(receipts);
}
main().then(console.log).catch(console.error);
