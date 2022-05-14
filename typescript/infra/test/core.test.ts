import '@nomiclabs/hardhat-waffle';
import { ethers } from 'hardhat';
import path from 'path';

import { AbacusCoreDeployer, CoreConfig } from '@abacus-network/deploy';
import {
  AbacusCore,
  ChainMap,
  CoreContractAddresses,
  MultiProvider,
  objMap,
} from '@abacus-network/sdk';

import { TestNetworks } from '../config/environments/test/domains';
import { getCoreEnvironmentConfig } from '../scripts/utils';
import { AbacusCoreChecker } from '../src/core';
import { AbacusCoreInfraDeployer } from '../src/core/deploy';

describe('core', async () => {
  const environment = 'test';

  let multiProvider: MultiProvider<TestNetworks>;
  let deployer: AbacusCoreInfraDeployer<TestNetworks>;
  let core: AbacusCore<TestNetworks>;
  let addresses: ChainMap<
    TestNetworks,
    CoreContractAddresses<TestNetworks, any>
  >;
  let coreConfig: ChainMap<TestNetworks, CoreConfig>;

  let owners: ChainMap<TestNetworks, string>;
  before(async () => {
    const config = getCoreEnvironmentConfig(environment);
    multiProvider = await config.getMultiProvider();
    coreConfig = config.core;
    deployer = new AbacusCoreInfraDeployer(multiProvider, coreConfig);
    const [, owner] = await ethers.getSigners();
    owners = objMap(config.transactionConfigs, () => owner.address);
  });

  it('deploys', async () => {
    addresses = await deployer.deploy(); // TODO: return AbacusApp from AbacusDeployer.deploy()
  });

  it('writes', async () => {
    const base = './test/outputs/core';
    deployer.writeVerification(path.join(base, 'verification'));
    deployer.writeContracts(addresses, path.join(base, 'contracts.ts'));
    deployer.writeRustConfigs(environment, path.join(base, 'rust'), addresses);
  });

  it('transfers ownership', async () => {
    core = new AbacusCore(addresses, multiProvider);
    await AbacusCoreDeployer.transferOwnership(core, owners, multiProvider);
  });

  it('checks', async () => {
    const joinedConfig = objMap(coreConfig, (network, config) => ({
      ...config,
      owner: owners[network],
    }));
    const checker = new AbacusCoreChecker(multiProvider, core, joinedConfig);
    await checker.check();
  });
});
