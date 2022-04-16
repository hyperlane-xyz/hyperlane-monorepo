import { utils } from '@abacus-network/deploy';
import {
  AbacusCore,
  AbacusGovernance,
  coreAddresses,
  governanceAddresses,
} from '@abacus-network/sdk';
import { AbacusCoreGovernor, CoreViolationType } from '../src/core';
import { getCoreEnvironmentConfig, getEnvironment } from './utils';

async function main() {
  const environment = await getEnvironment();
  const core = new AbacusCore(coreAddresses);
  const governance = new AbacusGovernance(governanceAddresses);
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
