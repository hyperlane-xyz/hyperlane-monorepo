import '@nomiclabs/hardhat-waffle';
import { assert, expect } from 'chai';
import hre from 'hardhat';
import sinon from 'sinon';

import { objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import { TestChains } from '../consts/chains.js';
import { HyperlaneContractsMap } from '../contracts/types.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { AggregationIsmConfig, IsmType } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { testCoreConfig } from '../test/testUtils.js';
import { ChainMap } from '../types.js';

import { HyperlaneCore } from './HyperlaneCore.js';
import { HyperlaneCoreChecker } from './HyperlaneCoreChecker.js';
import { HyperlaneCoreDeployer } from './HyperlaneCoreDeployer.js';
import { CoreFactories } from './contracts.js';
import { CoreConfig } from './types.js';

describe('core', async () => {
  let multiProvider: MultiProvider;
  let deployer: HyperlaneCoreDeployer;
  let core: HyperlaneCore;
  let contracts: HyperlaneContractsMap<CoreFactories>;
  let coreConfig: ChainMap<CoreConfig>;
  let ismFactory: HyperlaneIsmFactory;

  before(async () => {
    const [signer] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    const proxyFactoryDeployer = new HyperlaneProxyFactoryDeployer(
      multiProvider,
    );
    coreConfig = testCoreConfig(TestChains, signer.address);
    const ismFactories = await proxyFactoryDeployer.deploy(coreConfig);
    ismFactory = new HyperlaneIsmFactory(ismFactories, multiProvider);
    deployer = new HyperlaneCoreDeployer(multiProvider, ismFactory);
  });

  it('deploys', async () => {
    contracts = await deployer.deploy(coreConfig);
    core = new HyperlaneCore(contracts, multiProvider);
  });

  describe('idempotency', () => {
    beforeEach(async () => {
      contracts = await deployer.deploy(coreConfig);
    });

    it('rotates default and required hooks and recovers artifacts', async () => {
      const getHooks = async (
        contracts: HyperlaneContractsMap<CoreFactories>,
      ) =>
        promiseObjAll(
          objMap(contracts, async (_, { mailbox }) => ({
            default: await mailbox.defaultHook(),
            required: await mailbox.requiredHook(),
          })),
        );

      const hooksBefore = await getHooks(contracts);

      const updatedConfig = objMap(coreConfig, (_, config) => ({
        ...config,
        defaultHook: config.requiredHook,
        requiredHook: config.defaultHook,
      }));

      const [signer] = await hre.ethers.getSigners();
      const nonceBefore = await signer.getTransactionCount();

      const updatedContracts = await deployer.deploy(updatedConfig);

      const hooksAfter = await getHooks(updatedContracts);
      expect(hooksBefore).to.deep.equal(
        objMap(hooksAfter, (_, res) => ({
          required: res.default,
          default: res.required,
        })),
      );

      // number of set hook transactions
      const numTransactions = 2 * TestChains.length;
      const nonceAfter = await signer.getTransactionCount();
      expect(nonceAfter).to.equal(nonceBefore + numTransactions);
    });

    it('rotates default ISMs', async () => {
      const testIsm = await contracts.test1.mailbox.defaultIsm();

      const updatedConfig: ChainMap<CoreConfig> = objMap(
        coreConfig,
        (_, config) => {
          const ismConfig: AggregationIsmConfig = {
            type: IsmType.AGGREGATION,
            modules: [testIsm, testIsm],
            threshold: 2,
          };
          return {
            ...config,
            defaultIsm: ismConfig,
          };
        },
      );

      const [signer] = await hre.ethers.getSigners();
      const nonceBefore = await signer.getTransactionCount();

      await deployer.deploy(updatedConfig);

      // 3x1 for aggregation ISM deploy
      // 3x1 for setting ISM transaction for mailbox
      // 3x1 for setting ISM transaction for test recipient
      const numTransactions = 3 * TestChains.length;
      const nonceAfter = await signer.getTransactionCount();
      expect(nonceAfter).to.equal(nonceBefore + numTransactions);
    });
  });

  describe('failure modes', async () => {
    beforeEach(async () => {
      deployer = new HyperlaneCoreDeployer(multiProvider, ismFactory);
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
      // Each test network key has entries about the other test networks, where ISM details are stored.
      // With this exception, the keys should be the same, so we check the intersections for equality.
      const testnetKeysIntersection = Object.keys(result.test1).filter(
        (key) =>
          Object.keys(result.test2).includes(key) &&
          Object.keys(result.test3).includes(key),
      );
      assert(
        testnetKeysIntersection.length > 0,
        'there are no common core contracts deployed between the local testnets',
      );
    });

    it('can be resumed from partial contracts', async () => {
      sinon.restore(); // restore normal deployer behavior

      //@ts-ignore operand not optional, ignore for this test
      delete deployer.deployedContracts.test2!.multisigIsm;
      //@ts-ignore operand not optional, ignore for this test
      delete deployer.deployedContracts.test2!.mailbox;

      const result = await deployer.deploy(coreConfig);

      const testnetKeysIntersection = Object.keys(result.test1).filter(
        (key) =>
          Object.keys(result.test2).includes(key) &&
          Object.keys(result.test3).includes(key),
      );
      assert(
        testnetKeysIntersection.length > 0,
        'there are no common core contracts deployed between the local testnets',
      );
    });

    it('times out ', async () => {
      // @ts-ignore
      deployer.chainTimeoutMs = 1;
      try {
        await deployer.deploy(coreConfig);
      } catch (e: any) {
        // TODO: figure out how to test specific error case
        // expect(e.message).to.include('Timed out in 1ms');
      }
    });
  });

  it('checks', async () => {
    const checker = new HyperlaneCoreChecker(
      multiProvider,
      core,
      coreConfig,
      ismFactory,
    );
    await checker.check();
  });
});
