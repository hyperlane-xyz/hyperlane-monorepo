import '@nomiclabs/hardhat-waffle';
import { expect } from 'chai';
import { ethers } from 'hardhat';
import path from 'path';
import sinon from 'sinon';

import {
  AbacusCore,
  AbacusCoreChecker,
  AbacusCoreDeployer,
  ChainMap,
  CoreConfig,
  CoreContractsMap,
  MultiProvider,
  getTestMultiProvider,
  objMap,
  serializeContracts,
} from '@hyperlane-xyz/sdk';

import { environment as testConfig } from '../config/environments/test';
import { TestChains } from '../config/environments/test/chains';
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
  beforeEach(async () => {
    const [signer, owner] = await ethers.getSigners();
    // This is kind of awkward and really these tests shouldn't live here
    multiProvider = getTestMultiProvider(signer, testConfig.transactionConfigs);
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
    deployer.writeRustConfigs(environment, path.join(base, 'rust'));
  });

  it('transfers ownership', async () => {
    core = new AbacusCore(contracts, multiProvider);
    await AbacusCoreDeployer.transferOwnership(core, owners, multiProvider);
  });

  describe('failure modes', async () => {
    beforeEach(async () => {
      const stub = sinon.stub(deployer, 'deployContracts');
      stub.withArgs('test3', sinon.match.any).rejects();
      // @ts-ignore
      deployer.deployContracts.callThrough();

      try {
        await deployer.deploy();
        // eslint-disable-next-line no-empty
      } catch (e: any) {}
    });

    afterEach(async () => {
      sinon.restore();
    });

    it('persists partial failure', async () => {
      expect(deployer.deployedContracts).to.have.keys(['test1', 'test2']);
    });

    it('can be resumed from partial (chain) failure', async () => {
      sinon.restore(); // restore normal deployer behavior and test3 will be deployed
      const result = await deployer.deploy();
      expect(result).to.have.keys(['test1', 'test2', 'test3']);
      expect(result.test3).to.have.keys(Object.keys(result.test2));
    });

    it('can be resumed from partial contracts', async () => {
      sinon.restore(); // restore normal deployer behavior

      delete deployer.deployedContracts.test2!.abacusConnectionManager;
      delete deployer.deployedContracts.test2!.outbox;

      const result = await deployer.deploy();
      expect(result.test2).to.have.keys(Object.keys(result.test1));
      expect(result.test3).to.have.keys(Object.keys(result.test1));
    });
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
