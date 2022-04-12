import path from 'path';
import '@nomiclabs/hardhat-waffle';
import { ethers } from 'hardhat';
import { types } from '@abacus-network/utils';
import { AbacusCore } from '@abacus-network/sdk';
import { registerHardhatEnvironment } from '@abacus-network/deploy'
import { AbacusCoreDeployer, AbacusCoreChecker } from '../src/core';
import {
  core as coreConfig,
  environment,
} from '../config/environments/test';

describe('core', async () => {
  const deployer = new AbacusCoreDeployer();
  let core: AbacusCore;

  const owners: Record<types.Domain, types.Address> = {};
  before(async () => {
    const [signer, owner] = await ethers.getSigners();
    registerHardhatEnvironment(deployer, environment, signer);
    deployer.domainNumbers.map((d) => {
      owners[d] = owner.address;
    });
  });

  it('deploys', async () => {
    await deployer.deploy(coreConfig);
  });

  it('writes', async () => {
    const base = './test/outputs/core';
    deployer.writeVerification(path.join(base, 'verification'));
    deployer.writeContracts(path.join(base, 'contracts.ts'));
    deployer.writeRustConfigs('test', path.join(base, 'rust'));
  });

  it('transfers ownership', async () => {
    core = new AbacusCore(deployer.addressesRecord);
    const [signer] = await ethers.getSigners();
    registerHardhatEnvironment(core, environment, signer);
    await AbacusCoreDeployer.transferOwnership(core, owners);
  });

  it('checks', async () => {
    const checker = new AbacusCoreChecker(core, coreConfig);
    await checker.check(owners);
  });
});
