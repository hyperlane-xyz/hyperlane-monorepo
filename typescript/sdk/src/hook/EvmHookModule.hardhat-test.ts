/* eslint-disable no-console */
import { expect } from 'chai';
import hre from 'hardhat';

import {
  Address,
  configDeepEquals,
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

  const chain = TestChainName.test4;
  let proxyFactoryAddresses: HyperlaneAddresses<ProxyFactoryFactories>;
  let factoryContracts: HyperlaneContracts<ProxyFactoryFactories>;

  beforeEach(async () => {
    const [signer] = await hre.ethers.getSigners();
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
  });

  // Helper method for checking whether Hook module matches a given config
  async function hookModuleMatchesConfig({
    hook,
    config,
  }: {
    hook: EvmHookModule;
    config: HookConfig;
  }): Promise<boolean> {
    const normalizedDerivedConfig = normalizeConfig(await hook.read());
    const normalizedConfig = normalizeConfig(config);
    const matches = configDeepEquals(normalizedDerivedConfig, normalizedConfig);
    if (!matches) {
      console.error(
        'Derived config:\n',
        stringifyObject(normalizedDerivedConfig),
      );
      console.error('Expected config:\n', stringifyObject(normalizedConfig));
    }
    return matches;
  }

  // hook module and config for testing
  let testHook: EvmHookModule;
  let testConfig: HookConfig;

  // expect that the hook matches the config after all tests
  afterEach(async () => {
    expect(
      await hookModuleMatchesConfig({ hook: testHook, config: testConfig }),
    ).to.be.true;
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
    testConfig = config;
    testHook = hook;
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
});
