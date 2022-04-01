import path from 'path';
import '@nomiclabs/hardhat-waffle';
import { ethers } from 'hardhat';
import { types } from '@abacus-network/utils';
import { AbacusGovernance } from '@abacus-network/sdk';
import {
  AbacusGovernanceDeployer,
  AbacusGovernanceChecker,
} from '../src/governance';
import {
  registerMultiProviderTest,
  governance as governanceConfig,
} from '../config/environments/test';

describe('governance', async () => {
  const governanceDeployer = new AbacusGovernanceDeployer();
  const owners: Record<types.Domain, types.Address> = {};

  before(async () => {
    const [signer] = await ethers.getSigners();
    registerMultiProviderTest(governanceDeployer, signer);

    governanceDeployer.domainNumbers.map((domain) => {
      const name = governanceDeployer.mustResolveDomainName(domain);
      const addresses = governanceConfig.addresses[name];
      if (!addresses) throw new Error('could not find addresses');
      const owner = addresses.governor;
      owners[domain] = owner ? owner : ethers.constants.AddressZero;
    })

    // Setting for connection manager can be anything for a test deployment.
    if (!governanceConfig.xAppConnectionManager) {
      governanceConfig.xAppConnectionManager = {};
      governanceDeployer.domainNumbers.map((domain) => {
        const name = governanceDeployer.mustResolveDomainName(domain);
        governanceConfig.xAppConnectionManager![name] = signer.address;
      })
    }
  });

  it('deploys', async () => {
    await governanceDeployer.deploy(governanceConfig);
  });

  it('writes', async () => {
    const base = './test/outputs/governance';
    governanceDeployer.writeVerification(path.join(base, 'verification'));
    governanceDeployer.writeContracts(path.join(base, 'contracts.ts'));
  });

  it('checks', async () => {
    const governance = new AbacusGovernance(governanceDeployer.addressesRecord);
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
