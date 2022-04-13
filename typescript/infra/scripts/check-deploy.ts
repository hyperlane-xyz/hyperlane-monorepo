import { types } from '@abacus-network/utils';
import { AbacusCore, AbacusGovernance } from '@abacus-network/sdk';
import { utils } from '@abacus-network/deploy';

import { getEnvironment, getCoreEnvironmentConfig } from './utils';
import { AbacusCoreChecker } from '../src/core';
import { AbacusGovernanceChecker } from '../src/governance';

async function check() {
  const environment = await getEnvironment();
  const core = new AbacusCore(environment);
  const governance = new AbacusGovernance(environment);
  const config = await getCoreEnvironmentConfig(environment);
  await utils.registerEnvironment(core, config);
  await utils.registerEnvironment(governance, config);

  const governors: Record<types.Domain, types.Address> = {};
  governance.domainNumbers.map((domain) => {
    const addresses =
      config.governance.addresses[governance.mustResolveDomainName(domain)];
    if (!addresses) throw new Error('could not find addresses');
    governors[domain] = addresses.governor;
  });

  const governanceChecker = new AbacusGovernanceChecker(
    governance,
    config.governance,
  );
  await governanceChecker.check(governors);
  governanceChecker.expectEmpty();

  const coreChecker = new AbacusCoreChecker(core, config.core);
  await coreChecker.check(governance.routerAddresses);
  coreChecker.expectEmpty();
}

check().then(console.log).catch(console.error);
