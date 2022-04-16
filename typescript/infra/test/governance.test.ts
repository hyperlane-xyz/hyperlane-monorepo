import { utils } from '@abacus-network/deploy';
import { AbacusGovernance } from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';
import '@nomiclabs/hardhat-waffle';
import { ethers } from 'hardhat';
import path from 'path';
import { environment } from '../config/environments/test';
import {
  AbacusGovernanceChecker,
  AbacusGovernanceDeployer,
} from '../src/governance';

describe('governance', async () => {
  const deployer = new AbacusGovernanceDeployer();
  const owners: Record<types.Domain, types.Address> = {};
  const governanceConfig = environment.governance;

  before(async () => {
    const [signer] = await ethers.getSigners();
    utils.registerHardhatEnvironment(deployer, environment, signer);

    deployer.domainNumbers.map((domain) => {
      const name = deployer.mustResolveDomainName(domain);
      const addresses = governanceConfig.addresses[name];
      if (!addresses) throw new Error('could not find addresses');
      const owner = addresses.governor;
      owners[domain] = owner ? owner : ethers.constants.AddressZero;
    });

    // xAppConnectionManager can be set to anything for these tests.
    if (!governanceConfig.xAppConnectionManager) {
      governanceConfig.xAppConnectionManager = {};
      deployer.domainNames.map((name) => {
        governanceConfig.xAppConnectionManager![name] = signer.address;
      });
    }
  });

  it('deploys', async () => {
    await deployer.deploy(governanceConfig);
  });

  it('writes', async () => {
    const base = './test/outputs/governance';
    deployer.writeVerification(path.join(base, 'verification'));
    deployer.writeContracts(path.join(base, 'contracts.ts'));
  });

  it('checks', async () => {
    const governance = new AbacusGovernance(deployer.addressesRecord as any); // TODO: fix types
    const [signer] = await ethers.getSigners();
    utils.registerHardhatEnvironment(governance, environment, signer);

    const checker = new AbacusGovernanceChecker(governance, governanceConfig);
    await checker.check(owners as any); // TODO: fix types
  });
});
