import { core, governance } from '@abacus-network/sdk';
import { getCoreConfig, getEnvironment, registerMultiProvider } from './utils';
import { ViolationType } from '../src/common';
import { AbacusCoreChecker } from '../src/core';
import { expectCalls, GovernanceCallBatchBuilder } from '../src/core/govern';

async function main() {
  const environment = await getEnvironment();
  const abacusCore = core[environment];
  const abacusGovernance = governance[environment];
  registerMultiProvider(abacusCore, environment);
  registerMultiProvider(abacusGovernance, environment);

  const config = await getCoreConfig(environment);
  const checker = new AbacusCoreChecker(
    abacusCore,
    config,
    abacusGovernance.routerAddresses(),
  );
  await checker.check();
  checker.expectViolations(
    [ViolationType.Validator],
    [abacusCore.domainNumbers.length],
  );

  const builder = new GovernanceCallBatchBuilder(
    abacusCore,
    abacusGovernance,
    checker.violations,
  );
  const batch = await builder.build();

  await batch.build();
  // For each domain, expect one call to set the updater.
  expectCalls(
    batch,
    abacusCore.domainNumbers,
    new Array(abacusCore.domainNumbers.length).fill(1),
  );
  // Change to `batch.execute` in order to run.
  const receipts = await batch.estimateGas();
  console.log(receipts);
}
main().then(console.log).catch(console.error);
