import '@nomiclabs/hardhat-waffle';
import { ethers } from 'hardhat';
import { types } from '@abacus-network/utils';
import { AbacusGovernance } from '@abacus-network/sdk';
import { AbacusCoreDeployer } from '../src/core';
import {
  AbacusGovernanceDeployer,
  AbacusGovernanceChecker,
  GovernanceConfig,
} from '../src/governance';
import { core as coreConfig, registerMultiProvider, governance as partialGovernanceConfig } from '../config/environments/local';

describe('governance', async () => {
  const coreDeployer = new AbacusCoreDeployer();
  const deployer = new AbacusGovernanceDeployer();
  let governanceConfig: GovernanceConfig;
  const owners: Record<types.Domain, types.Address> = {};

  before(async () => {
    await registerMultiProvider(coreDeployer);
    await coreDeployer.deploy(coreConfig);
    governanceConfig = { ...partialGovernanceConfig, core: {} };
    coreDeployer.domainNumbers.map((domain) => {
      const name = coreDeployer.mustResolveDomainName(domain)
      const addresses = partialGovernanceConfig.addresses[name];
      if (!addresses) throw new Error('could not find addresses');
      const owner = addresses.governor;
      owners[domain] = owner ? owner : ethers.constants.AddressZero;
      const coreAddresses = coreDeployer.mustGetAddresses(domain)
      governanceConfig.core[name] = {
        upgradeBeaconController: coreAddresses.upgradeBeaconController,
        xAppConnectionManager: coreAddresses.xAppConnectionManager,
      };
    });
  });

  it('deploys', async () => {
    await deployer.deploy(governanceConfig);
  });

  it('writes', async () => {
    deployer.writeOutput('./test/outputs');
  });

  it('checks', async () => {
    const governance = new AbacusGovernance(deployer.addressesRecord())
    await registerMultiProvider(governance)

    const checker = new AbacusGovernanceChecker(
      governance,
      governanceConfig,
      owners,
    );
    await checker.check();
  });
});
