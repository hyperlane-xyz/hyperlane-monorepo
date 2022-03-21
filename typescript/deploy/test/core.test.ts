import '@nomiclabs/hardhat-waffle';
import { ethers } from 'hardhat';
import { types } from '@abacus-network/utils';
import { AbacusCore } from '@abacus-network/sdk';
import { DeployEnvironment } from '../src/config';
import { AbacusCoreDeployer, AbacusCoreChecker } from '../src/core';
import { core as coreConfig, registerMultiProvider } from '../config/environments/local';

describe('core', async () => {
  let core: AbacusCore;
  const deployer = new AbacusCoreDeployer();

  const owners: Record<types.Domain, types.Address> = {};
  before(async () => {
    const [_, owner] = await ethers.getSigners();
    deployer.domainNumbers.map((d) => {
      owners[d] = owner.address;
    })
    await registerMultiProvider(deployer);
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
    await registerMultiProvider(core)
    deployer.domainNumbers.forEach(async (d) => {
      await core.mustGetContracts(d).transferOwnership(owners[d]);
    })
  });

  it('checks', async () => {
    const checker = new AbacusCoreChecker(core, coreConfig, owners);
    await checker.check();
  });
});
