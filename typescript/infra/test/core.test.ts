import '@nomiclabs/hardhat-waffle';
import { ethers } from 'hardhat';
import path from 'path';

import { AbacusCoreDeployer, CoreConfig } from '@abacus-network/deploy';
import { getMultiProviderFromConfigAndSigner } from '@abacus-network/deploy/dist/src/utils';
import {
  AbacusCore,
  ChainMap,
  CoreContractsMap,
  MultiProvider,
  objMap,
  serializeContracts,
} from '@abacus-network/sdk';

import { environment as testConfig } from '../config/environments/test';
import { TestChains } from '../config/environments/test/chains';
import { AbacusCoreChecker } from '../src/core';
import { AbacusCoreInfraDeployer } from '../src/core/deploy';
import { writeJSON } from '../src/utils/utils';

describe('core', async () => {
  const environment = 'test';

  let multiProvider: MultiProvider<TestChains>;
  let deployer: AbacusCoreInfraDeployer<TestChains>;
  let core: AbacusCore<TestChains>;
  let contracts: CoreContractsMap<TestChains>;
  let coreConfig: ChainMap<TestChains, CoreConfig>;

  let owners: ChainMap<TestChains, string>;
  before(async () => {
    const [signer, owner] = await ethers.getSigners();
    // This is kind of awkward and really these tests shouldn't live here
    multiProvider = getMultiProviderFromConfigAndSigner(
      testConfig.transactionConfigs,
      signer,
    );
    coreConfig = testConfig.core;
    deployer = new AbacusCoreInfraDeployer(multiProvider, coreConfig);
    owners = objMap(testConfig.transactionConfigs, () => owner.address);
  });

  it('deploys', async () => {
    contracts = await deployer.deploy();
  });

  it('writes', async () => {
    const base = './test/outputs/core';
    writeJSON(base, 'contracts.json', serializeContracts(contracts));
    writeJSON(base, 'verification.json', deployer.verificationInputs);
    deployer.writeRustConfigs(environment, path.join(base, 'rust'), contracts);
  });

  it('transfers ownership', async () => {
    core = new AbacusCore(contracts, multiProvider);
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
