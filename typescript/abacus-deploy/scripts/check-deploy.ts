import {ethers} from 'ethers';
import { types } from '@abacus-network/utils';

import {
  getBridgeDeploy,
  getBridgeConfig,
  getCoreDeploy,
  getCoreConfig,
  getEnvironment,
  getGovernanceDeploy,
  getGovernanceConfig,
} from './utils';
import { CoreInvariantChecker } from '../src/core';
import { BridgeInvariantChecker } from '../src/bridge';
import { GovernanceInvariantChecker } from '../src/governance';

async function check() {
  const environment = await getEnvironment();
  const governance = await getGovernanceDeploy(environment);
  const governanceConfig = await getGovernanceConfig(environment);
  const governors: Record<types.Domain, types.Address> = {}
  governance.domains.map((domain) => {
    const addresses = governanceConfig.addresses[governance.name(domain)];
    if (addresses === undefined) throw new Error('could not find addresses');
    governors[domain] = addresses.governor ? addresses.governor : ethers.constants.AddressZero;
  })
  const governanceChecker = new GovernanceInvariantChecker(
    governance,
    governanceConfig,
    governors,
  )
  await governanceChecker.check();
  governanceChecker.expectEmpty();

  const core = await getCoreDeploy(environment);
  const coreConfig = await getCoreConfig(environment);
  const coreChecker = new CoreInvariantChecker(
    core,
    coreConfig,
    governance.routerAddresses(),
  );
  await coreChecker.check();
  coreChecker.expectEmpty();

  const bridge = await getBridgeDeploy(environment);
  const bridgeConfig = await getBridgeConfig(environment);
  const bridgeChecker = new BridgeInvariantChecker(
    bridge,
    bridgeConfig,
    governance.routerAddresses(),
  );
  await bridgeChecker.check();
}

check().then(console.log).catch(console.error);
