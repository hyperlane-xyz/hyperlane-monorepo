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
import {
  core as coreConfig,
  registerMultiProviderTest,
  governance as partialGovernanceConfig,
} from '../config/environments/local';

describe('governance', async () => {
  const coreDeployer = new AbacusCoreDeployer();
  const governanceDeployer = new AbacusGovernanceDeployer();
  const owners: Record<types.Domain, types.Address> = {};
  let governanceConfig: GovernanceConfig;

  before(async () => {
    const [signer] = await ethers.getSigners();
    registerMultiProviderTest(governanceDeployer, signer);
    registerMultiProviderTest(coreDeployer, signer);
    await coreDeployer.deploy(coreConfig);

    governanceConfig = { ...partialGovernanceConfig, core: {} };
    coreDeployer.domainNumbers.map((domain) => {
      const name = coreDeployer.mustResolveDomainName(domain);
      const addresses = partialGovernanceConfig.addresses[name];
      if (!addresses) throw new Error('could not find addresses');
      const owner = addresses.governor;
      owners[domain] = owner ? owner : ethers.constants.AddressZero;
      const coreAddresses = coreDeployer.mustGetAddresses(domain);
      governanceConfig.core[name] = {
        upgradeBeaconController: coreAddresses.upgradeBeaconController,
        xAppConnectionManager: coreAddresses.xAppConnectionManager,
      };
    });
  });

  it('deploys', async () => {
    await governanceDeployer.deploy(governanceConfig);
  });

  it('writes', async () => {
    governanceDeployer.writeOutput('./test/outputs');
  });

  it('checks', async () => {
    const governance = new AbacusGovernance(
      governanceDeployer.addressesRecord(),
    );
    const [signer] = await ethers.getSigners();
    registerMultiProviderTest(governance, signer);

    const checker = new AbacusGovernanceChecker(
      governance,
      governanceConfig,
      owners,
    );
    await checker.check();
  });
});
