import '@nomiclabs/hardhat-waffle';
import { expect } from 'chai';
import { ethers } from 'hardhat';
import sinon from 'sinon';

import { CoreFactories } from '@hyperlane-xyz/sdk/dist/core/contracts';

import { TestChains } from '../consts/chains';
import { HyperlaneContractsMap } from '../contracts';
import { MultiProvider } from '../providers/MultiProvider';
import { testCoreConfig } from '../test/testUtils';
import { ChainMap } from '../types';

import { HyperlaneCore } from './HyperlaneCore';
import { HyperlaneCoreChecker } from './HyperlaneCoreChecker';
import { HyperlaneCoreDeployer } from './HyperlaneCoreDeployer';
import { CoreConfig } from './types';

describe('core', async () => {
  let multiProvider: MultiProvider;
  let deployer: HyperlaneCoreDeployer;
  let core: HyperlaneCore;
  let contracts: HyperlaneContractsMap<CoreFactories>;
  let coreConfig: ChainMap<CoreConfig>;

  beforeEach(async () => {
    const [signer] = await ethers.getSigners();
    // This is kind of awkward and really these tests shouldn't live here
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    coreConfig = testCoreConfig(TestChains);
  });

  it('deploys', async () => {
    deployer = new HyperlaneCoreDeployer(multiProvider);
    contracts = await deployer.deploy(coreConfig);
    core = new HyperlaneCore(contracts, multiProvider);
  });

  describe('failure modes', async () => {
    beforeEach(async () => {
      deployer = new HyperlaneCoreDeployer(multiProvider);
      const stub = sinon.stub(deployer, 'deployContracts');
      stub.withArgs('test3', sinon.match.any).rejects();
      // @ts-ignore
      deployer.deployContracts.callThrough();

      try {
        await deployer.deploy(coreConfig);
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
      const result = await deployer.deploy(coreConfig);
      expect(result).to.have.keys(['test1', 'test2', 'test3']);
      expect(result.test3).to.have.keys(Object.keys(result.test2));
    });

    it('can be resumed from partial contracts', async () => {
      sinon.restore(); // restore normal deployer behavior

      //@ts-ignore operand not optional, ignore for this test
      delete deployer.deployedContracts.test2!.multisigIsm;
      //@ts-ignore operand not optional, ignore for this test
      delete deployer.deployedContracts.test2!.mailbox;

      const result = await deployer.deploy(coreConfig);
      expect(result.test2).to.have.keys(Object.keys(result.test1));
      expect(result.test3).to.have.keys(Object.keys(result.test1));
    });
  });

  it('checks', async () => {
    const checker = new HyperlaneCoreChecker(multiProvider, core, coreConfig);
    await checker.check();
  });
});
