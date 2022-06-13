import '@nomiclabs/hardhat-waffle';
import { expect } from 'chai';
import { ethers } from 'hardhat';
import path from 'path';

import {
  AbacusCoreChecker,
  AbacusCoreDeployer,
  CoreConfig,
} from '@abacus-network/deploy';
import { getMultiProviderFromConfigAndSigner } from '@abacus-network/deploy/dist/src/utils';
import {
  AbacusCore,
  ChainMap,
  CoreContracts,
  CoreContractsMap,
  MultiProvider,
  objMap,
  serializeContracts,
} from '@abacus-network/sdk';

import { environment as testConfig } from '../config/environments/test';
import { TestChains } from '../config/environments/test/chains';
import { AbacusCoreInfraDeployer } from '../src/core/deploy';
import { writeJSON } from '../src/utils/utils';

class FlakeyCoreInfraDeployer extends AbacusCoreInfraDeployer<TestChains> {
  async deployContracts<LocalChain extends TestChains>(
    chain: TestChains,
    config: CoreConfig,
  ): Promise<CoreContracts<TestChains, LocalChain>> {
    if (chain === 'test3') {
      throw new Error('test3 failure');
    }
    return super.deployContracts(chain, config) as any;
  }
}

describe('core', async () => {
  const environment = 'test';

  let multiProvider: MultiProvider<TestChains>;
  let deployer: AbacusCoreInfraDeployer<TestChains>;
  let core: AbacusCore<TestChains>;
  let contracts: CoreContractsMap<TestChains>;
  let coreConfig: ChainMap<TestChains, CoreConfig>;
  let flakeyDeployer: FlakeyCoreInfraDeployer;

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
    flakeyDeployer = new FlakeyCoreInfraDeployer(multiProvider, coreConfig);
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

  it('persists partial failure', async () => {
    try {
      await flakeyDeployer.deploy();
    } catch (e) {}
    expect(flakeyDeployer.deployedContracts).to.have.keys(['test1', 'test2']);
  });

  it('can be resumed from partial failure', async () => {
    const result = await deployer.deploy(
      flakeyDeployer.deployedContracts as any,
    );
    expect(result).to.have.keys(['test1', 'test2', 'test3']);
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
