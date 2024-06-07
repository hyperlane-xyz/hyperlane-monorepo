/* eslint-disable no-console */
import assert from 'assert';
import { expect } from 'chai';
import { Signer } from 'ethers';
import hre from 'hardhat';

import {
  Address,
  eqAddress,
  normalizeConfig,
  stringifyObject,
} from '@hyperlane-xyz/utils';

import { TestChainName, testChains } from '../consts/testChains.js';
import { HyperlaneAddresses, HyperlaneContracts } from '../contracts/types.js';
import { TestCoreDeployer } from '../core/TestCoreDeployer.js';
import { CoreAddresses } from '../core/contracts.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { randomAddress, randomInt } from '../test/testUtils.js';

import { EvmHookModule } from './EvmHookModule.js';
import {
  AggregationHookConfig,
  DomainRoutingHookConfig,
  FallbackRoutingHookConfig,
  HookConfig,
  HookType,
  IgpHookConfig,
  MerkleTreeHookConfig,
  PausableHookConfig,
  ProtocolFeeHookConfig,
} from './types.js';

const hookTypes = Object.values(HookType);

function randomHookType(): HookType {
  // OP_STACK filtering is temporary until we have a way to deploy the required contracts
  const filteredHookTypes = hookTypes.filter(
    (type) => type !== HookType.OP_STACK && type !== HookType.CUSTOM,
  );
  return filteredHookTypes[
    Math.floor(Math.random() * filteredHookTypes.length)
  ];
}

function randomProtocolFee(): { maxProtocolFee: string; protocolFee: string } {
  const maxProtocolFee = Math.random() * 100000000000000;
  const protocolFee = (Math.random() * maxProtocolFee) / 1000;
  return {
    maxProtocolFee: Math.floor(maxProtocolFee).toString(),
    protocolFee: Math.floor(protocolFee).toString(),
  };
}

function randomHookConfig(
  depth = 0,
  maxDepth = 2,
  providedHookType?: HookType,
): HookConfig {
  const hookType: HookType = providedHookType ?? randomHookType();

  if (depth >= maxDepth) {
    if (
      hookType === HookType.AGGREGATION ||
      hookType === HookType.ROUTING ||
      hookType === HookType.FALLBACK_ROUTING
    ) {
      return { type: HookType.MERKLE_TREE };
    }
  }

  switch (hookType) {
    case HookType.MERKLE_TREE:
      return { type: hookType };

    case HookType.AGGREGATION:
      return {
        type: hookType,
        hooks: [
          randomHookConfig(depth + 1, maxDepth),
          randomHookConfig(depth + 1, maxDepth),
        ],
      };

    case HookType.INTERCHAIN_GAS_PAYMASTER: {
      const owner = randomAddress();
      return {
        owner,
        type: hookType,
        beneficiary: randomAddress(),
        oracleKey: owner,
        overhead: Object.fromEntries(
          testChains.map((c) => [c, Math.floor(Math.random() * 100)]),
        ),
        oracleConfig: Object.fromEntries(
          testChains.map((c) => [
            c,
            {
              tokenExchangeRate: randomInt(1234567891234).toString(),
              gasPrice: randomInt(1234567891234).toString(),
            },
          ]),
        ),
      };
    }

    case HookType.PROTOCOL_FEE: {
      const { maxProtocolFee, protocolFee } = randomProtocolFee();
      return {
        owner: randomAddress(),
        type: hookType,
        maxProtocolFee,
        protocolFee,
        beneficiary: randomAddress(),
      };
    }

    case HookType.OP_STACK:
      return {
        owner: randomAddress(),
        type: hookType,
        nativeBridge: randomAddress(),
        destinationChain: 'testChain',
      };

    case HookType.ROUTING:
      return {
        owner: randomAddress(),
        type: hookType,
        domains: Object.fromEntries(
          testChains.map((c) => [c, randomHookConfig(depth + 1, maxDepth)]),
        ),
      };

    case HookType.FALLBACK_ROUTING:
      return {
        owner: randomAddress(),
        type: hookType,
        fallback: randomHookConfig(depth + 1, maxDepth),
        domains: Object.fromEntries(
          testChains.map((c) => [c, randomHookConfig(depth + 1, maxDepth)]),
        ),
      };

    case HookType.PAUSABLE:
      return {
        owner: randomAddress(),
        type: hookType,
        paused: false,
      };

    default:
      throw new Error(`Unsupported Hook type: ${hookType}`);
  }
}

describe('EvmHookModule', async () => {
  let multiProvider: MultiProvider;
  let coreAddresses: CoreAddresses;
  let fundingAccount: Signer;

  const chain = TestChainName.test4;
  let proxyFactoryAddresses: HyperlaneAddresses<ProxyFactoryFactories>;
  let factoryContracts: HyperlaneContracts<ProxyFactoryFactories>;

  let exampleRoutingConfig: DomainRoutingHookConfig | FallbackRoutingHookConfig;

  beforeEach(async () => {
    const [signer, funder] = await hre.ethers.getSigners();
    fundingAccount = funder;
    multiProvider = MultiProvider.createTestMultiProvider({ signer });

    const ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
    const contractsMap = await ismFactoryDeployer.deploy(
      multiProvider.mapKnownChains(() => ({})),
    );

    // get addresses of factories for the chain
    factoryContracts = contractsMap[chain];
    proxyFactoryAddresses = Object.keys(factoryContracts).reduce((acc, key) => {
      acc[key] =
        contractsMap[chain][key as keyof ProxyFactoryFactories].address;
      return acc;
    }, {} as Record<string, Address>) as HyperlaneAddresses<ProxyFactoryFactories>;

    // legacy HyperlaneIsmFactory is required to do a core deploy
    const legacyIsmFactory = new HyperlaneIsmFactory(
      contractsMap,
      multiProvider,
    );

    // core deployer for tests
    const testCoreDeployer = new TestCoreDeployer(
      multiProvider,
      legacyIsmFactory,
    );

    // mailbox and proxy admin for the core deploy
    const { mailbox, proxyAdmin, validatorAnnounce } = (
      await testCoreDeployer.deployApp()
    ).getContracts(chain);

    coreAddresses = {
      mailbox: mailbox.address,
      proxyAdmin: proxyAdmin.address,
      validatorAnnounce: validatorAnnounce.address,
    };

    exampleRoutingConfig = {
      owner: (await multiProvider.getSignerAddress(chain)).toLowerCase(),
      domains: Object.fromEntries(
        testChains.map((c) => [
          c,
          {
            type: HookType.MERKLE_TREE,
          },
        ]),
      ),
      type: HookType.FALLBACK_ROUTING,
      fallback: { type: HookType.MERKLE_TREE },
    };
  });

  // Helper method for create a new multiprovider with an impersonated account
  async function impersonateAccount(account: Address): Promise<MultiProvider> {
    await hre.ethers.provider.send('hardhat_impersonateAccount', [account]);
    await fundingAccount.sendTransaction({
      to: account,
      value: hre.ethers.utils.parseEther('1.0'),
    });
    return MultiProvider.createTestMultiProvider({
      signer: hre.ethers.provider.getSigner(account),
    });
  }

  // Helper method to expect exactly N updates to be applied
  async function expectTxsAndUpdate(
    hook: EvmHookModule,
    config: HookConfig,
    n: number,
  ) {
    const txs = await hook.update(config);
    expect(txs.length).to.equal(n);

    for (const tx of txs) {
      await multiProvider.sendTransaction(chain, tx);
    }
  }

  // hook module and config for testing
  let testHook: EvmHookModule;
  let testConfig: HookConfig;

  // expect that the hook matches the config after all tests
  afterEach(async () => {
    const normalizedDerivedConfig = normalizeConfig(await testHook.read());
    const normalizedConfig = normalizeConfig(testConfig);
    assert.deepStrictEqual(normalizedDerivedConfig, normalizedConfig);
  });

  // create a new Hook and verify that it matches the config
  async function createHook(
    config: HookConfig,
  ): Promise<{ hook: EvmHookModule; initialHookAddress: Address }> {
    console.log('Creating hook with config: ', stringifyObject(config));
    const hook = await EvmHookModule.create({
      chain,
      config,
      proxyFactoryFactories: proxyFactoryAddresses,
      coreAddresses,
      multiProvider,
    });
    testHook = hook;
    testConfig = config;
    return { hook, initialHookAddress: hook.serialize().deployedHook };
  }

  describe('create', async () => {
    it('deploys a hook of type CUSTOM', async () => {
      const config: HookConfig = randomAddress();
      await createHook(config);
    });

    it('deploys a hook of type MERKLE_TREE', async () => {
      const config: MerkleTreeHookConfig = {
        type: HookType.MERKLE_TREE,
      };
      await createHook(config);
    });

    it('deploys a hook of type INTERCHAIN_GAS_PAYMASTER', async () => {
      const owner = randomAddress();
      const config: IgpHookConfig = {
        owner,
        type: HookType.INTERCHAIN_GAS_PAYMASTER,
        beneficiary: randomAddress(),
        oracleKey: owner,
        overhead: Object.fromEntries(
          testChains.map((c) => [c, Math.floor(Math.random() * 100)]),
        ),
        oracleConfig: Object.fromEntries(
          testChains.map((c) => [
            c,
            {
              tokenExchangeRate: randomInt(1234567891234).toString(),
              gasPrice: randomInt(1234567891234).toString(),
            },
          ]),
        ),
      };
      await createHook(config);
    });

    it('deploys a hook of type PROTOCOL_FEE', async () => {
      const { maxProtocolFee, protocolFee } = randomProtocolFee();
      const config: ProtocolFeeHookConfig = {
        owner: randomAddress(),
        type: HookType.PROTOCOL_FEE,
        maxProtocolFee,
        protocolFee,
        beneficiary: randomAddress(),
      };
      await createHook(config);
    });

    it('deploys a hook of type ROUTING', async () => {
      const config: DomainRoutingHookConfig = {
        owner: randomAddress(),
        type: HookType.ROUTING,
        domains: Object.fromEntries(
          testChains
            .filter((c) => c !== TestChainName.test4)
            .map((c) => [
              c,
              {
                type: HookType.MERKLE_TREE,
              },
            ]),
        ),
      };
      await createHook(config);
    });

    it('deploys a hook of type FALLBACK_ROUTING', async () => {
      const config: FallbackRoutingHookConfig = {
        owner: randomAddress(),
        type: HookType.FALLBACK_ROUTING,
        fallback: { type: HookType.MERKLE_TREE },
        domains: Object.fromEntries(
          testChains
            .filter((c) => c !== TestChainName.test4)
            .map((c) => [
              c,
              {
                type: HookType.MERKLE_TREE,
              },
            ]),
        ),
      };
      await createHook(config);
    });

    it('deploys a hook of type AGGREGATION', async () => {
      const config: AggregationHookConfig = {
        type: HookType.AGGREGATION,
        hooks: [{ type: HookType.MERKLE_TREE }, { type: HookType.MERKLE_TREE }],
      };
      await createHook(config);
    });

    it('deploys a hook of type PAUSABLE', async () => {
      const config: PausableHookConfig = {
        owner: randomAddress(),
        type: HookType.PAUSABLE,
        paused: false,
      };
      await createHook(config);
    });

    // it('deploys a hook of type OP_STACK', async () => {
    // need to setup deploying/mocking IL1CrossDomainMessenger before this test can be enabled
    //   const config: OpStackHookConfig = {
    //     owner: randomAddress(),
    //     type: HookType.OP_STACK,
    //     nativeBridge: randomAddress(),
    //     destinationChain: 'testChain',
    //   };
    //   await createHook(config);
    // });

    for (let i = 0; i < 16; i++) {
      it(`deploys a random hook config #${i}`, async () => {
        // random config with depth 0-2
        const config = randomHookConfig();
        await createHook(config);
      });
    }

    it('regression test #1', async () => {
      const config: HookConfig = {
        type: HookType.AGGREGATION,
        hooks: [
          {
            owner: '0xebe67f0a423fd1c4af21debac756e3238897c665',
            type: HookType.INTERCHAIN_GAS_PAYMASTER,
            beneficiary: '0xfe3be5940327305aded56f20359761ef85317554',
            oracleKey: '0xebe67f0a423fd1c4af21debac756e3238897c665',
            overhead: {
              test1: 18,
              test2: 85,
              test3: 23,
              test4: 69,
            },
            oracleConfig: {
              test1: {
                tokenExchangeRate: '1032586497157',
                gasPrice: '1026942205817',
              },
              test2: {
                tokenExchangeRate: '81451154935',
                gasPrice: '1231220057593',
              },
              test3: {
                tokenExchangeRate: '31347320275',
                gasPrice: '21944956734',
              },
              test4: {
                tokenExchangeRate: '1018619796544',
                gasPrice: '1124484183261',
              },
            },
          },
          {
            owner: '0xcc803fc9e6551b9eaaebfabbdd5af3eccea252ff',
            type: HookType.ROUTING,
            domains: {
              test1: {
                type: HookType.MERKLE_TREE,
              },
              test2: {
                owner: '0x7e43dfa88c4a5d29a8fcd69883b7f6843d465ca3',
                type: HookType.INTERCHAIN_GAS_PAYMASTER,
                beneficiary: '0x762e71a849a3825613cf5cbe70bfff27d0fe7766',
                oracleKey: '0x7e43dfa88c4a5d29a8fcd69883b7f6843d465ca3',
                overhead: {
                  test1: 46,
                  test2: 34,
                  test3: 47,
                  test4: 24,
                },
                oracleConfig: {
                  test1: {
                    tokenExchangeRate: '1132883204938',
                    gasPrice: '1219466305935',
                  },
                  test2: {
                    tokenExchangeRate: '938422264723',
                    gasPrice: '229134538568',
                  },
                  test3: {
                    tokenExchangeRate: '69699594189',
                    gasPrice: '475781234236',
                  },
                  test4: {
                    tokenExchangeRate: '1027245678936',
                    gasPrice: '502686418976',
                  },
                },
              },
              test3: {
                type: HookType.MERKLE_TREE,
              },
              test4: {
                owner: '0xa1ce72b70566f2cba6000bfe6af50f0f358f49d7',
                type: HookType.INTERCHAIN_GAS_PAYMASTER,
                beneficiary: '0x9796c0c49c61fe01eb1a8ba56d09b831f6da8603',
                oracleKey: '0xa1ce72b70566f2cba6000bfe6af50f0f358f49d7',
                overhead: {
                  test1: 71,
                  test2: 16,
                  test3: 37,
                  test4: 13,
                },
                oracleConfig: {
                  test1: {
                    tokenExchangeRate: '443874625350',
                    gasPrice: '799154764503',
                  },
                  test2: {
                    tokenExchangeRate: '915348561750',
                    gasPrice: '1124345797215',
                  },
                  test3: {
                    tokenExchangeRate: '930832717805',
                    gasPrice: '621743941770',
                  },
                  test4: {
                    tokenExchangeRate: '147394981623',
                    gasPrice: '766494385983',
                  },
                },
              },
            },
          },
        ],
      };
      await createHook(config);
    });
  });

  describe('update', async () => {
    for (const type of [HookType.ROUTING, HookType.FALLBACK_ROUTING]) {
      beforeEach(() => {
        exampleRoutingConfig.type = type as
          | HookType.ROUTING
          | HookType.FALLBACK_ROUTING;
      });

      it(`should update ${type} hook`, async () => {
        // create a new hook
        const { hook, initialHookAddress } = await createHook(
          exampleRoutingConfig,
        );

        // update the hook with some random new config
        const newConfig: MerkleTreeHookConfig = {
          type: HookType.MERKLE_TREE,
        };
        testConfig = newConfig;

        // expect a fresh hook to be deployed which means 0 txs returned
        await expectTxsAndUpdate(hook, newConfig, 0);

        // expect a fresh hook address
        expect(eqAddress(initialHookAddress, hook.serialize().deployedHook)).to
          .be.false;
      });

      it(`should skip deployment with warning if no chain metadata configured ${type}`, async () => {
        // create a new hook
        const { hook } = await createHook(exampleRoutingConfig);

        // add config for a domain the multiprovider doesn't have
        const updatedConfig: HookConfig = {
          ...exampleRoutingConfig,
          domains: {
            ...exampleRoutingConfig.domains,
            test5: { type: HookType.MERKLE_TREE },
          },
        };

        // expect 0 txs, as adding test5 domain is no-op
        await expectTxsAndUpdate(hook, updatedConfig, 0);
      });

      it(`updates owner in an existing ${type}`, async () => {
        // create a new hook
        const { hook, initialHookAddress } = await createHook(
          exampleRoutingConfig,
        );

        // change the config owner
        exampleRoutingConfig.owner = randomAddress();

        // expect 1 tx to transfer ownership
        await expectTxsAndUpdate(hook, exampleRoutingConfig, 1);

        // expect the hook address to be the same
        expect(eqAddress(initialHookAddress, hook.serialize().deployedHook)).to
          .be.true;
      });

      it(`no changes to an existing ${type} means no redeployment or updates`, async () => {
        // create a new hook
        const { hook, initialHookAddress } = await createHook(
          exampleRoutingConfig,
        );

        // expect 0 updates
        await expectTxsAndUpdate(hook, exampleRoutingConfig, 0);

        // expect the hook address to be the same
        expect(eqAddress(initialHookAddress, hook.serialize().deployedHook)).to
          .be.true;
      });

      it(`update owner in an existing ${type} not owned by deployer`, async () => {
        // hook owner is not the deployer
        exampleRoutingConfig.owner = randomAddress();
        const originalOwner = exampleRoutingConfig.owner;

        // create a new hook
        const { hook, initialHookAddress } = await createHook(
          exampleRoutingConfig,
        );

        // update the config owner and impersonate the original owner
        exampleRoutingConfig.owner = randomAddress();
        multiProvider = await impersonateAccount(originalOwner);

        // expect 1 tx to transfer ownership
        await expectTxsAndUpdate(hook, exampleRoutingConfig, 1);

        // expect the hook address to be unchanged
        expect(eqAddress(initialHookAddress, hook.serialize().deployedHook)).to
          .be.true;
      });
    }
  });
});
