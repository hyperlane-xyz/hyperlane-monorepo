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
  objMap,
  serializeContracts,
} from '@hyperlane-xyz/sdk';

import { environment as testConfig } from '../config/environments/test';
import { HyperlaneCoreInfraDeployer } from '../src/core/deploy';
import { writeJSON } from '../src/utils/utils';

describe('core', async () => {
  const environment = 'test';

  let multiProvider: MultiProvider;
  let deployer: HyperlaneCoreInfraDeployer;
  let core: HyperlaneCore;
  let contracts: CoreContractsMap;
  let coreConfig: ChainMap<CoreConfig>;

  let owners: ChainMap<string>;
  beforeEach(async () => {
    const [signer, owner] = await ethers.getSigners();
    // This is kind of awkward and really these tests shouldn't live here
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
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

      //@ts-ignore operand not optional, ignore for this test
      delete deployer.deployedContracts.test2!.multisigIsm;
      //@ts-ignore operand not optional, ignore for this test
      delete deployer.deployedContracts.test2!.mailbox;

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
    const checker = new HyperlaneCoreChecker(multiProvider, core, joinedConfig);
    await checker.check();
  });
});
