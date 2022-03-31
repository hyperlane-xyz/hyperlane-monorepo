import {
  AbacusCore,
  AbacusGovernance,
  coreAddresses,
  governanceAddresses,
} from '@abacus-network/sdk';
import { getCoreConfig, getEnvironment, registerMultiProvider } from './utils';
import { AbacusCoreGovernor, CoreViolationType } from '../src/core';

async function main() {
  const environment = await getEnvironment();
  const core = new AbacusCore(coreAddresses[environment]);
  const governance = new AbacusGovernance(governanceAddresses[environment]);
  registerMultiProvider(core, environment);
  registerMultiProvider(governance, environment);

  const config = await getCoreConfig(environment);
  const governor = new AbacusCoreGovernor(core, config, governance);
  await governor.check();
  // Sanity check: for each domain, expect one validator violation.
  governor.expectViolations(
    [CoreViolationType.Validator],
    [core.domainNumbers.length],
  );
  // Sanity check: f each domain, expect one call to set the updater.
  governor.expectCalls(
    core.domainNumbers,
    new Array(core.domainNumbers.length).fill(1),
  );

  const governorDomain = (await governance.governor()).domain;
  // Change to `batch.execute` in order to run.
  const receipts = await governor.governance.estimateGas(governorDomain);
  console.log(receipts);
}
main().then(console.log).catch(console.error);
