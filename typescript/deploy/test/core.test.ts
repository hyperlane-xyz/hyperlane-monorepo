import '@nomiclabs/hardhat-waffle';
import { ethers } from 'hardhat';
import { types } from '@abacus-network/utils';
import { AbacusCore } from '@abacus-network/sdk';
import { DeployEnvironment } from '../src/config';
import { AbacusCoreDeployer, AbacusCoreChecker } from '../src/core';
import { core as coreConfig, registerMultiProviderTest } from '../config/environments/local';

describe('core', async () => {
  const deployer = new AbacusCoreDeployer();
  let core: AbacusCore;

  const owners: Record<types.Domain, types.Address> = {};
  before(async () => {
    const [signer, owner] = await ethers.getSigners();
    registerMultiProviderTest(deployer, signer);
    deployer.domainNumbers.map((d) => {
      owners[d] = owner.address;
    })
  });

  it('deploys', async () => {
    await deployer.deploy(coreConfig);
  });

  it('writes', async () => {
    const outputDir = './test/outputs'
    deployer.writeOutput(outputDir)
    deployer.writeRustConfigs(DeployEnvironment.dev, outputDir);
  });

  it('transfers ownership', async () => {
    core = new AbacusCore(deployer.addressesRecord())
    const [signer] = await ethers.getSigners();
    registerMultiProviderTest(core, signer);
    await core.transferOwnership(owners);
  });

  it('checks', async () => {
    const checker = new AbacusCoreChecker(core, coreConfig, owners);
    await checker.check();
  });
});
