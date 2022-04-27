import { utils } from '@abacus-network/deploy';
import {
  AbacusCore,
  ChainSubsetMap,
  CoreContractAddresses,
  MultiProvider,
} from '@abacus-network/sdk';
import { objMap } from '@abacus-network/sdk/dist/utils';
import '@nomiclabs/hardhat-waffle';
import { ethers } from 'hardhat';
import path from 'path';
import { environment } from '../config/environments/test';
import { ENVIRONMENTS_ENUM } from '../src/config/environment';
import { AbacusCoreChecker, AbacusCoreDeployer } from '../src/core';

describe('core', async () => {
  type networks = keyof typeof environment.transactionConfigs;
  let multiProvider: MultiProvider<networks>;
  let deployer: AbacusCoreDeployer<networks>;
  let core: AbacusCore<networks>;
  let addresses: ChainSubsetMap<networks, CoreContractAddresses<networks, any>>;

  let owners: ChainSubsetMap<networks, string>;
  before(async () => {
    const [signer, owner] = await ethers.getSigners();
    multiProvider = utils.initHardhatMultiProvider(environment, signer);
    deployer = new AbacusCoreDeployer(multiProvider, environment.core);
    owners = objMap(environment.transactionConfigs, () => owner.address);
  });

  it('deploys', async () => {
    addresses = await deployer.deploy();
  });

  it('writes', async () => {
    const base = './test/outputs/core';
    deployer.writeVerification(path.join(base, 'verification'));
    deployer.writeContracts(addresses, path.join(base, 'contracts.ts'));
    deployer.writeRustConfigs(
      ENVIRONMENTS_ENUM.Test,
      path.join(base, 'rust'),
      addresses,
    );
  });

  it('transfers ownership', async () => {
    core = new AbacusCore(addresses, multiProvider);
    await AbacusCoreDeployer.transferOwnership(core, owners, multiProvider);
  });

  it('checks', async () => {
    const checker = new AbacusCoreChecker(
      multiProvider,
      core,
      environment.core,
    );
    await checker.check(owners, addresses);
  });
});
