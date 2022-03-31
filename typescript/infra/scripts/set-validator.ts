import {
  AbacusCore,
  AbacusGovernance,
  coreAddresses,
  governanceAddresses,
} from '@abacus-network/sdk';
import { getCoreConfig, getEnvironment, registerMultiProvider } from './utils';
import { AbacusCoreGovernor, CoreViolationType, expectCalls} from '../src/core';

async function main() {
  const environment = await getEnvironment();
  const core = new AbacusCore(coreAddresses[environment]);
  const governance = new AbacusGovernance(governanceAddresses[environment]);
  registerMultiProvider(core, environment);
  registerMultiProvider(governance, environment);

  const config = await getCoreConfig(environment);
  const governor = new AbacusCoreGovernor(core, config, governance);
  await governor.check();
  governor.expectViolations(
    [CoreViolationType.Validator],
    [core.domainNumbers.length],
  );

  const batch = await governor.build();
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
