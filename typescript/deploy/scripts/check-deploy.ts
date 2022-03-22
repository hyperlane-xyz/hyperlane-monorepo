import { ethers } from 'ethers';
import { types } from '@abacus-network/utils';
import { cores, bridges, governances } from '@abacus-network/sdk';

import {
  getBridgeConfig,
  getCoreConfig,
  getEnvironment,
  getGovernanceConfig,
  registerMultiProvider,
} from './utils';
import { AbacusCoreChecker } from '../src/core';
import { AbacusBridgeChecker } from '../src/bridge';
import { AbacusGovernanceChecker } from '../src/governance';

async function check() {
  const environment = await getEnvironment();
  const core = cores[environment];
  const bridge = bridges[environment];
  const governance = governances[environment];
  registerMultiProvider(core, environment);
  registerMultiProvider(bridge, environment);
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

  const bridgeConfig = await getBridgeConfig(environment, core);
  const bridgeChecker = new AbacusBridgeChecker(
    bridge,
    bridgeConfig,
    governance.routerAddresses,
  );
  await bridgeChecker.check();
  bridgeChecker.expectEmpty();
}

check().then(console.log).catch(console.error);
