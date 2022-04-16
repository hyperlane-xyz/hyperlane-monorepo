import { utils } from '@abacus-network/deploy';
import {
  AbacusCore,
  AbacusGovernance,
  coreAddresses,
  governanceAddresses,
} from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';
import { AbacusCoreChecker } from '../src/core';
import { AbacusGovernanceChecker } from '../src/governance';
import { getCoreEnvironmentConfig, getEnvironment } from './utils';

async function check() {
  const environment = await getEnvironment();
  const core = new AbacusCore(coreAddresses);
  const governance = new AbacusGovernance(governanceAddresses);
  const config = await getCoreEnvironmentConfig(environment);
  utils.registerEnvironment(core, config);
  utils.registerEnvironment(governance, config);

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
  await governanceChecker.check(governors as any);
  governanceChecker.expectEmpty();

  const coreChecker = new AbacusCoreChecker(core, config.core);
  await coreChecker.check(governance.routerAddresses);
  coreChecker.expectEmpty();
}

check().then(console.log).catch(console.error);
