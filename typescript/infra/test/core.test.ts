import '@nomiclabs/hardhat-waffle';
import { expect } from 'chai';
import { ethers } from 'hardhat';
import sinon from 'sinon';

import {
  ChainMap,
  CoreConfig,
  CoreContractsMap,
  HyperlaneCore,
  HyperlaneCoreChecker,
  MultiProvider,
  getTestMultiProvider,
  objMap,
  serializeContracts,
} from '@hyperlane-xyz/sdk';

import { environment as testConfig } from '../config/environments/test';
import { TestChains } from '../config/environments/test/chains';
import { HyperlaneCoreInfraDeployer } from '../src/core/deploy';
import { writeJSON } from '../src/utils/utils';

describe('core', async () => {
  const environment = 'test';

  let multiProvider: MultiProvider<TestChains>;
  let deployer: HyperlaneCoreInfraDeployer<TestChains>;
  let core: HyperlaneCore<TestChains>;
  let contracts: CoreContractsMap<TestChains>;
  let coreConfig: ChainMap<TestChains, CoreConfig>;

  let owners: ChainMap<TestChains, string>;
  beforeEach(async () => {
    const [signer, owner] = await ethers.getSigners();
    // This is kind of awkward and really these tests shouldn't live here
    multiProvider = getTestMultiProvider(signer, testConfig.transactionConfigs);
    coreConfig = testConfig.core;
    owners = objMap(testConfig.transactionConfigs, () => owner.address);
  });

  it('deploys', async () => {
    deployer = new HyperlaneCoreInfraDeployer(
      multiProvider,
      coreConfig,
      environment,
    );
    contracts = await deployer.deploy();
    core = new HyperlaneCore(contracts, multiProvider);
  });

  it('writes', async () => {
    const base = './test/outputs/core';
    writeJSON(base, 'contracts.json', serializeContracts(contracts));
    writeJSON(base, 'verification.json', deployer.verificationInputs);
    deployer.writeRustConfigs(base);
  });

  describe('failure modes', async () => {
    beforeEach(async () => {
      deployer = new HyperlaneCoreInfraDeployer(
        multiProvider,
        coreConfig,
        environment,
      );
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

      delete deployer.deployedContracts.test2!.multisigIsm;
      delete deployer.deployedContracts.test2!.mailbox;

      const result = await deployer.deploy();
      expect(result.test2).to.have.keys(Object.keys(result.test1));
      expect(result.test3).to.have.keys(Object.keys(result.test1));
    });
  });

  describe('proxy upgrades', async () => {
    beforeEach(async () => {
      deployer = new HyperlaneCoreInfraDeployer(
        multiProvider,
        coreConfig,
        environment,
      );
      await deployer.deploy();
    });

    it('deploys a new implementation if it has been removed from the artifacts', async () => {
      // Copy the old addresses
      const oldAddresses = {
        ...deployer.deployedContracts.test2!.interchainGasPaymaster!.addresses,
      };
      // @ts-ignore
      delete deployer.deployedContracts.test2!.interchainGasPaymaster!.addresses
        .implementation;
      const result = await deployer.deploy();
      const newAddresses = result.test2.interchainGasPaymaster.addresses;
      // New implementation
      expect(newAddresses.implementation).to.not.be.undefined;
      expect(newAddresses.implementation).to.not.equal(
        oldAddresses.implementation,
      );
      // Same proxy
      expect(newAddresses.proxy).to.equal(oldAddresses.proxy);
    });
  });

  it('checks', async () => {
    const joinedConfig = objMap(coreConfig, (chain, config) => ({
      ...config,
      owner: owners[chain],
    }));
    const checker = new HyperlaneCoreChecker(multiProvider, core, joinedConfig);
    await checker.check();
  });
});
