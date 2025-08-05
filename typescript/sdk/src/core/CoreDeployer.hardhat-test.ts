import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import '@nomiclabs/hardhat-waffle';
import { assert, expect } from 'chai';
import hre from 'hardhat';
import sinon from 'sinon';

import { Address, objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import { TestChainName, testChains } from '../consts/testChains.js';
import { HyperlaneContractsMap } from '../contracts/types.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { DerivedHookConfig } from '../hook/types.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import {
  AggregationIsmConfig,
  DerivedIsmConfig,
  IsmType,
} from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { testCoreConfig } from '../test/testUtils.js';
import { ChainMap } from '../types.js';

import { EvmCoreReader } from './EvmCoreReader.js';
import { EvmIcaModule } from './EvmIcaModule.js';
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
  let signer: SignerWithAddress;

  before(async () => {
    [signer] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    const proxyFactoryDeployer = new HyperlaneProxyFactoryDeployer(
      multiProvider,
    );
    coreConfig = testCoreConfig(testChains, signer.address);
    const ismFactories = await proxyFactoryDeployer.deploy(coreConfig);
    ismFactory = new HyperlaneIsmFactory(ismFactories, multiProvider);
    deployer = new HyperlaneCoreDeployer(multiProvider, ismFactory);

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
      const numTransactions = 2 * testChains.length;
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
      const numTransactions = 3 * testChains.length;
      const nonceAfter = await signer.getTransactionCount();
      expect(nonceAfter).to.equal(nonceBefore + numTransactions);
    });
  });

  describe('CoreConfigReader', async () => {
    let icaRouterAddressMap: ChainMap<Address>;

    beforeEach(async () => {
      contracts = await deployer.deploy(coreConfig);

      const icaMap: ChainMap<Address> = {};
      for (const chain of Object.keys(contracts)) {
        const { interchainAccountRouter } = (
          await EvmIcaModule.create({
            chain,
            multiProvider: multiProvider,
            config: {
              commitmentIsm: {
                type: IsmType.OFFCHAIN_LOOKUP,
                urls: ['https://commitment-read-ism.hyperlane.xyz'],
                owner: signer.address,
              },
              mailbox: contracts[chain].mailbox.address,
              owner: signer.address,
            },
          })
        ).serialize();
        icaMap[chain] = interchainAccountRouter;
      }

      icaRouterAddressMap = icaMap;
    });

    async function deriveCoreConfig(
      chainName: string,
      mailboxAddress: string,
      icaRouterAddress: string,
    ) {
      return new EvmCoreReader(multiProvider, chainName).deriveCoreConfig({
        mailbox: mailboxAddress,
        interchainAccountRouter: icaRouterAddress,
      });
    }

    it('should derive defaultIsm correctly', async () => {
      await promiseObjAll(
        objMap(contracts, async (chainName, contract) => {
          const coreConfigOnChain = await deriveCoreConfig(
            chainName,
            contract.mailbox.address,
            icaRouterAddressMap[chainName],
          );

          // Cast because we don't expect the 'string' type
          const { address: _, ...defaultIsmOnchain } =
            coreConfigOnChain.defaultIsm as DerivedIsmConfig;
          const defaultIsmTest = coreConfig[chainName]
            .defaultIsm as DerivedIsmConfig;

          expect(defaultIsmOnchain).to.deep.equal(defaultIsmTest);
        }),
      );
    });

    it('should derive defaultHook correctly', async () => {
      await promiseObjAll(
        objMap(contracts, async (chainName, contract) => {
          const coreConfigOnChain = await deriveCoreConfig(
            chainName,
            contract.mailbox.address,
            icaRouterAddressMap[chainName],
          );

          // Cast because we don't expect the 'string' type
          const { address: _, ...defaultHookOnchain } =
            coreConfigOnChain.defaultHook as DerivedHookConfig;
          const defaultHookTest = coreConfig[chainName]
            .defaultHook as DerivedHookConfig;

          expect(defaultHookOnchain).to.deep.equal(defaultHookTest);
        }),
      );
    });

    it('should derive requiredHook correctly', async () => {
      await promiseObjAll(
        objMap(contracts, async (chainName, contract) => {
          const coreConfigOnChain = await deriveCoreConfig(
            chainName,
            contract.mailbox.address,
            icaRouterAddressMap[chainName],
          );
          const { address: _, ...requiredHookOnchain } =
            coreConfigOnChain.requiredHook as DerivedHookConfig;
          const requiredHookTest = coreConfig[chainName].requiredHook;

          expect(requiredHookOnchain).to.deep.equal(requiredHookTest);
        }),
      );
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
      } catch {}
    });

    afterEach(async () => {
      sinon.restore();
    });

    it('persists partial failure', async () => {
      expect(deployer.deployedContracts).to.have.keys([
        TestChainName.test1,
        TestChainName.test2,
      ]);
    });

    it('can be resumed from partial (chain) failure', async () => {
      sinon.restore(); // restore normal deployer behavior and test3 will be deployed
      const result = await deployer.deploy(coreConfig);
      expect(result).to.have.keys(testChains);
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
      } catch {
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
      {},
    );
    await checker.check();
  });
});
