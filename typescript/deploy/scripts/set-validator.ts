import {
  AbacusCore,
  AbacusGovernance,
  coreAddresses,
  governanceAddresses,
} from '@abacus-network/sdk';
import { getCoreConfig, getEnvironment, registerMultiProvider } from './utils';
import { ViolationType } from '../src/check';
import { AbacusCoreChecker } from '../src/core';
import { expectCalls, GovernanceCallBatchBuilder } from '../src/core/govern';

async function main() {
  const environment = await getEnvironment();
  const core = new AbacusCore(coreAddresses[environment]);
  const governance = new AbacusGovernance(governanceAddresses[environment]);
  registerMultiProvider(core, environment);
  registerMultiProvider(governance, environment);

  const config = await getCoreConfig(environment);
  const checker = new AbacusCoreChecker(
    core,
    config,
    governance.routerAddresses,
  );
  await checker.check();
  checker.expectViolations(
    [ViolationType.Validator],
    [core.domainNumbers.length],
  );

  const builder = new GovernanceCallBatchBuilder(
    core,
    governance,
    checker.violations,
  );
  const batch = await builder.build();

  await batch.build();
  // For each domain, expect one call to set the updater.
  expectCalls(
    batch,
    core.domainNumbers,
    new Array(core.domainNumbers.length).fill(1),
  );
  // Change to `batch.execute` in order to run.
  const receipts = await batch.estimateGas();
  console.log(receipts);
}
main().then(console.log).catch(console.error);
