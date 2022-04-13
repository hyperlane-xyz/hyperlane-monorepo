import { AbacusCore, AbacusGovernance } from '@abacus-network/sdk';
import { utils } from '@abacus-network/deploy';
import { getEnvironment, getCoreEnvironmentConfig } from './utils';
import { AbacusCoreGovernor, CoreViolationType } from '../src/core';

async function main() {
  const environment = await getEnvironment();
  const core = new AbacusCore(environment);
  const governance = new AbacusGovernance(environment);
  const config = await getCoreEnvironmentConfig(environment);
  utils.registerEnvironment(core, config);
  utils.registerEnvironment(governance, config);

  const governor = new AbacusCoreGovernor(core, config.core, governance);
  await governor.check();
  // Sanity check: for each domain, expect one validator violation.
  governor.expectViolations(
    [CoreViolationType.Validator],
    [core.domainNumbers.length],
  );
  // Sanity check: for each domain, expect one call to set the validator.
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
