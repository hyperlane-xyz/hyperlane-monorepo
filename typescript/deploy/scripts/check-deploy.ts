import { ethers } from 'ethers';
import { types } from '@abacus-network/utils';
import { core, bridge, governance } from '@abacus-network/sdk';

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
  const abacusCore = core[environment];
  const abacusBridge = bridge[environment];
  const abacusGovernance = governance[environment];
  registerMultiProvider(abacusCore, environment);
  registerMultiProvider(abacusBridge, environment);
  registerMultiProvider(abacusGovernance, environment);

  const governanceConfig = await getGovernanceConfig(environment, abacusCore);
  const governors: Record<types.Domain, types.Address> = {};
  abacusGovernance.domainNumbers.map((domain) => {
    const addresses =
      governanceConfig.addresses[
        abacusGovernance.mustResolveDomainName(domain)
      ];
    if (!addresses) throw new Error('could not find addresses');
    governors[domain] = addresses.governor
      ? addresses.governor
      : ethers.constants.AddressZero;
  });
  const governanceChecker = new AbacusGovernanceChecker(
    abacusGovernance,
    governanceConfig,
    governors,
  );
  await governanceChecker.check();
  governanceChecker.expectEmpty();

  const coreConfig = await getCoreConfig(environment);
  const coreChecker = new AbacusCoreChecker(
    abacusCore,
    coreConfig,
    abacusGovernance.routerAddresses,
  );
  await coreChecker.check();
  coreChecker.expectEmpty();

  const bridgeConfig = await getBridgeConfig(environment, abacusCore);
  const bridgeChecker = new AbacusBridgeChecker(
    abacusBridge,
    bridgeConfig,
    abacusGovernance.routerAddresses,
  );
  await bridgeChecker.check();
  bridgeChecker.expectEmpty();
}

check().then(console.log).catch(console.error);
