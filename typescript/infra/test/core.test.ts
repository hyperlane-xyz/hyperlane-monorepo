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

import { TestChains } from '../config/environments/test/chains';
import { getCoreEnvironmentConfig } from '../scripts/utils';
import { AbacusCoreChecker } from '../src/core';
import { AbacusCoreInfraDeployer } from '../src/core/deploy';

describe('core', async () => {
  const environment = 'test';

  let multiProvider: MultiProvider<TestChains>;
  let deployer: AbacusCoreInfraDeployer<TestChains>;
  let core: AbacusCore<TestChains>;
  let addresses: ChainMap<TestChains, CoreContractAddresses<TestChains, any>>;
  let coreConfig: ChainMap<TestChains, CoreConfig>;

  let owners: ChainMap<TestChains, string>;
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
    const joinedConfig = objMap(coreConfig, (chain, config) => ({
      ...config,
      owner: owners[chain],
    }));
    const checker = new AbacusCoreChecker(multiProvider, core, joinedConfig);
    await checker.check();
  });
});
