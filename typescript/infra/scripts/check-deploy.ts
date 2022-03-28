import { ethers } from 'ethers';
import { types } from '@abacus-network/utils';
import {
  AbacusCore,
  AbacusGovernance,
  coreAddresses,
  governanceAddresses,
} from '@abacus-network/sdk';

import {
  getCoreConfig,
  getEnvironment,
  getGovernanceConfig,
  registerMultiProvider,
} from './utils';
import { AbacusCoreChecker } from '../src/core';
import { AbacusGovernanceChecker } from '../src/governance';

async function check() {
  const environment = await getEnvironment();
  const core = new AbacusCore(coreAddresses[environment]);
  const governance = new AbacusGovernance(governanceAddresses[environment]);
  registerMultiProvider(core, environment);
  registerMultiProvider(governance, environment);

  const governanceConfig = await getGovernanceConfig(environment, core);
  const governors: Record<types.Domain, types.Address> = {};
  governance.domainNumbers.map((domain) => {
    const addresses =
      governanceConfig.addresses[governance.mustResolveDomainName(domain)];
    if (!addresses) throw new Error('could not find addresses');
    governors[domain] = addresses.governor
      ? addresses.governor
      : ethers.constants.AddressZero;
  });
  const governanceChecker = new AbacusGovernanceChecker(
    governance,
    governanceConfig,
    governors,
  );
  await governanceChecker.check();
  governanceChecker.expectEmpty();

  const coreConfig = await getCoreConfig(environment);
  const coreChecker = new AbacusCoreChecker(
    core,
    coreConfig,
    governance.routerAddresses,
  );
  await coreChecker.check();
  coreChecker.expectEmpty();
}

check().then(console.log).catch(console.error);
