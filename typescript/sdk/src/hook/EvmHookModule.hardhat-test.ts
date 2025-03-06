import { expect } from 'chai';
import { Signer } from 'ethers';
import hre from 'hardhat';

import {
  Address,
  WithAddress,
  assert,
  deepEquals,
  eqAddress,
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
import { normalizeConfig } from '../utils/ism.js';

import { EvmHookModule } from './EvmHookModule.js';
import {
  AggregationHookConfig,
  DomainRoutingHookConfig,
  FallbackRoutingHookConfig,
  HookConfig,
  HookType,
  IgpHookConfig,
  MUTABLE_HOOK_TYPE,
  PausableHookConfig,
  ProtocolFeeHookConfig,
} from './types.js';

const hookTypes = Object.values(HookType);
const DEFAULT_TOKEN_DECIMALS = 18;

function randomHookType(): HookType {
  // OP_STACK filtering is temporary until we have a way to deploy the required contracts
  // ARB_L2_TO_L1 filtered out until we have a way to deploy the required contracts (arbL2ToL1.hardhat-test.ts has the same test for checking deployment)
  const filteredHookTypes = hookTypes.filter(
    (type) =>
      type !== HookType.OP_STACK &&
      type !== HookType.ARB_L2_TO_L1 &&
      type !== HookType.CUSTOM,
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
              tokenDecimals: DEFAULT_TOKEN_DECIMALS,
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

    case HookType.ARB_L2_TO_L1:
      return {
        type: hookType,
        arbSys: randomAddress(),
        bridge: randomAddress(),
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
  const chain = TestChainName.test4;

  let multiProvider: MultiProvider;
  let coreAddresses: CoreAddresses;
  let signer: Signer;
  let funder: Signer;
  let proxyFactoryAddresses: HyperlaneAddresses<ProxyFactoryFactories>;
  let factoryContracts: HyperlaneContracts<ProxyFactoryFactories>;
  let exampleRoutingConfig: DomainRoutingHookConfig | FallbackRoutingHookConfig;

  before(async () => {
    [signer, funder] = await hre.ethers.getSigners();
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

    // reusable for routing/fallback routing specific tests
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
    await funder.sendTransaction({
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
    deepEquals(normalizedDerivedConfig, normalizedConfig);
  });

  // create a new Hook and verify that it matches the config
  async function createHook(
    config: HookConfig,
  ): Promise<{ hook: EvmHookModule; initialHookAddress: Address }> {
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
    // generate a random config for each hook type
    const exampleHookConfigs: HookConfig[] = [
      // include an address config
      randomAddress(),
      ...hookTypes
        // need to setup deploying/mocking IL1CrossDomainMessenger before this test can be enabled
        .filter(
          (hookType) =>
            hookType !== HookType.OP_STACK &&
            hookType !== HookType.ARB_L2_TO_L1 &&
            hookType !== HookType.CUSTOM,
        )
        // generate a random config for each hook type
        .map((hookType) => {
          return randomHookConfig(0, 1, hookType);
        }),
    ];

    // test deployment of each hookType, except OP_STACK and CUSTOM
    // minimum depth only
    for (const config of exampleHookConfigs) {
      it(`deploys a hook of type ${
        typeof config === 'string' ? 'address' : config.type
      }`, async () => {
        await createHook(config);
      });
    }

    // manually include test for CUSTOM hook type
    it('deploys a hook of type CUSTOM', async () => {
      const config: HookConfig = randomAddress();
      await createHook(config);
    });

    // random configs upto depth 2
    for (let i = 0; i < 16; i++) {
      it(`deploys a random hook config #${i}`, async () => {
        // random config with depth 0-2
        const config = randomHookConfig();
        await createHook(config);
      });
    }

    // manual test to catch regressions on a complex config type
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
                tokenDecimals: DEFAULT_TOKEN_DECIMALS,
              },
              test2: {
                tokenExchangeRate: '81451154935',
                gasPrice: '1231220057593',
                tokenDecimals: DEFAULT_TOKEN_DECIMALS,
              },
              test3: {
                tokenExchangeRate: '31347320275',
                gasPrice: '21944956734',
                tokenDecimals: DEFAULT_TOKEN_DECIMALS,
              },
              test4: {
                tokenExchangeRate: '1018619796544',
                gasPrice: '1124484183261',
                tokenDecimals: DEFAULT_TOKEN_DECIMALS,
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
                    tokenDecimals: DEFAULT_TOKEN_DECIMALS,
                  },
                  test2: {
                    tokenExchangeRate: '938422264723',
                    gasPrice: '229134538568',
                    tokenDecimals: DEFAULT_TOKEN_DECIMALS,
                  },
                  test3: {
                    tokenExchangeRate: '69699594189',
                    gasPrice: '475781234236',
                    tokenDecimals: DEFAULT_TOKEN_DECIMALS,
                  },
                  test4: {
                    tokenExchangeRate: '1027245678936',
                    gasPrice: '502686418976',
                    tokenDecimals: DEFAULT_TOKEN_DECIMALS,
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
                    tokenDecimals: DEFAULT_TOKEN_DECIMALS,
                  },
                  test2: {
                    tokenExchangeRate: '915348561750',
                    gasPrice: '1124345797215',
                    tokenDecimals: DEFAULT_TOKEN_DECIMALS,
                  },
                  test3: {
                    tokenExchangeRate: '930832717805',
                    gasPrice: '621743941770',
                    tokenDecimals: DEFAULT_TOKEN_DECIMALS,
                  },
                  test4: {
                    tokenExchangeRate: '147394981623',
                    gasPrice: '766494385983',
                    tokenDecimals: DEFAULT_TOKEN_DECIMALS,
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
    it('should update by deploying a new aggregation hook', async () => {
      const config: AggregationHookConfig = {
        type: HookType.AGGREGATION,
        hooks: [randomHookConfig(0, 2), randomHookConfig(0, 2)],
      };

      // create a new hook
      const { hook, initialHookAddress } = await createHook(config);

      // change the hooks
      config.hooks = [randomHookConfig(0, 2), randomHookConfig(0, 2)];

      // expect 0 tx to be returned, as it should deploy a new aggregation hook
      await expectTxsAndUpdate(hook, config, 0);

      // expect the hook address to be different
      expect(eqAddress(initialHookAddress, hook.serialize().deployedHook)).to.be
        .false;
    });

    const createDeployerOwnedIgpHookConfig =
      async (): Promise<IgpHookConfig> => {
        const owner = await multiProvider.getSignerAddress(chain);
        return {
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
                tokenDecimals: DEFAULT_TOKEN_DECIMALS,
              },
            ]),
          ),
        };
      };

    it('should update beneficiary in IGP', async () => {
      const config = await createDeployerOwnedIgpHookConfig();

      // create a new hook
      const { hook } = await createHook(config);

      // change the beneficiary
      config.beneficiary = randomAddress();

      // expect 1 tx to update the beneficiary
      await expectTxsAndUpdate(hook, config, 1);
    });

    it('should update the overheads in IGP', async () => {
      const config = await createDeployerOwnedIgpHookConfig();

      // create a new hook
      const { hook } = await createHook(config);

      // change the overheads
      config.overhead = Object.fromEntries(
        testChains.map((c) => [c, Math.floor(Math.random() * 100)]),
      );

      // expect 1 tx to update the overheads
      await expectTxsAndUpdate(hook, config, 1);
    });

    it('should update the oracle config in IGP', async () => {
      const config = await createDeployerOwnedIgpHookConfig();

      // create a new hook
      const { hook } = await createHook(config);

      // change the oracle config
      config.oracleConfig = Object.fromEntries(
        testChains.map((c) => [
          c,
          {
            tokenExchangeRate: randomInt(987654321).toString(),
            gasPrice: randomInt(987654321).toString(),
            tokenDecimals: DEFAULT_TOKEN_DECIMALS,
          },
        ]),
      );

      // expect 1 tx to update the oracle config
      await expectTxsAndUpdate(hook, config, 1);
    });

    it('should update protocol fee in protocol fee hook', async () => {
      const config: ProtocolFeeHookConfig = {
        owner: await multiProvider.getSignerAddress(chain),
        type: HookType.PROTOCOL_FEE,
        maxProtocolFee: '1000',
        protocolFee: '100',
        beneficiary: randomAddress(),
      };

      // create a new hook
      const { hook } = await createHook(config);

      // change the protocol fee
      config.protocolFee = '200';

      // expect 1 tx to update the protocol fee
      await expectTxsAndUpdate(hook, config, 1);
    });

    it('should update max fee in protocol fee hook', async () => {
      const config: ProtocolFeeHookConfig = {
        owner: await multiProvider.getSignerAddress(chain),
        type: HookType.PROTOCOL_FEE,
        maxProtocolFee: '1000',
        protocolFee: '100',
        beneficiary: randomAddress(),
      };

      // create a new hook
      const { hook, initialHookAddress } = await createHook(config);

      // change the protocol fee
      config.maxProtocolFee = '2000';

      // expect 0 tx to update the max protocol fee as it has to deploy a new hook
      await expectTxsAndUpdate(hook, config, 0);

      // expect the hook address to be different
      expect(eqAddress(initialHookAddress, hook.serialize().deployedHook)).to.be
        .false;
    });

    it('should update paused state of pausable hook', async () => {
      const config: PausableHookConfig = {
        owner: randomAddress(),
        type: HookType.PAUSABLE,
        paused: false,
      };

      // create a new hook
      const { hook } = await createHook(config);

      // change the paused state
      config.paused = true;

      // impersonate the hook owner
      multiProvider = await impersonateAccount(config.owner);

      // expect 1 tx to update the paused state
      await expectTxsAndUpdate(hook, config, 1);
    });

    for (const type of [HookType.ROUTING, HookType.FALLBACK_ROUTING]) {
      beforeEach(() => {
        exampleRoutingConfig.type = type as
          | HookType.ROUTING
          | HookType.FALLBACK_ROUTING;
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

      it(`updates an existing ${type} with new domains`, async () => {
        exampleRoutingConfig = {
          owner: (await multiProvider.getSignerAddress(chain)).toLowerCase(),
          domains: {
            test1: {
              type: HookType.MERKLE_TREE,
            },
          },
          type: HookType.FALLBACK_ROUTING,
          fallback: { type: HookType.MERKLE_TREE },
        };

        // create a new hook
        const { hook, initialHookAddress } = await createHook(
          exampleRoutingConfig,
        );

        // add a new domain
        exampleRoutingConfig.domains[TestChainName.test2] = {
          type: HookType.MERKLE_TREE,
        };

        // expect 1 tx to update the domains
        await expectTxsAndUpdate(hook, exampleRoutingConfig, 1);

        // expect the hook address to be the same
        expect(eqAddress(initialHookAddress, hook.serialize().deployedHook)).to
          .be.true;
      });

      it(`updates an existing ${type} with new domains`, async () => {
        exampleRoutingConfig = {
          owner: (await multiProvider.getSignerAddress(chain)).toLowerCase(),
          domains: {
            test1: {
              type: HookType.MERKLE_TREE,
            },
          },
          type: HookType.FALLBACK_ROUTING,
          fallback: { type: HookType.MERKLE_TREE },
        };

        // create a new hook
        const { hook, initialHookAddress } = await createHook(
          exampleRoutingConfig,
        );

        // add multiple new domains
        exampleRoutingConfig.domains[TestChainName.test2] = {
          type: HookType.MERKLE_TREE,
        };
        exampleRoutingConfig.domains[TestChainName.test3] = {
          type: HookType.MERKLE_TREE,
        };
        exampleRoutingConfig.domains[TestChainName.test4] = {
          type: HookType.MERKLE_TREE,
        };

        // expect 1 tx to update the domains
        await expectTxsAndUpdate(hook, exampleRoutingConfig, 1);

        // expect the hook address to be the same
        expect(eqAddress(initialHookAddress, hook.serialize().deployedHook)).to
          .be.true;
      });
    }

    it(`update fallback in an existing fallback routing hook`, async () => {
      // create a new hook
      const config = exampleRoutingConfig as FallbackRoutingHookConfig;
      const { hook, initialHookAddress } = await createHook(config);

      // change the fallback
      config.fallback = {
        type: HookType.PROTOCOL_FEE,
        owner: randomAddress(),
        maxProtocolFee: '9000',
        protocolFee: '350',
        beneficiary: randomAddress(),
      };

      // expect 0 tx as it will have to deploy a new fallback routing hook
      await expectTxsAndUpdate(hook, config, 0);

      // expect the hook address to be different
      expect(eqAddress(initialHookAddress, hook.serialize().deployedHook)).to.be
        .false;
    });

    it(`update fallback in an existing fallback routing hook with no change`, async () => {
      // create a new hook
      const config = exampleRoutingConfig as FallbackRoutingHookConfig;
      const { hook } = await createHook(config);

      // expect 0 updates
      await expectTxsAndUpdate(hook, config, 0);
    });

    it('should not update a hook if given address matches actual config', async () => {
      // create a new agg hook with the owner hardcoded
      const hookConfig: AggregationHookConfig = {
        type: HookType.AGGREGATION,
        hooks: [
          {
            ...(randomHookConfig(
              0,
              2,
              HookType.FALLBACK_ROUTING,
            ) as FallbackRoutingHookConfig),
            owner: '0xD1e6626310fD54Eceb5b9a51dA2eC329D6D4B68A',
          },
        ],
      };
      const { hook } = await createHook(hookConfig);
      const deployedHookBefore =
        (await hook.read()) as WithAddress<AggregationHookConfig>;

      // expect 0 updates, but actually deploys a new hook
      await expectTxsAndUpdate(hook, hookConfig, 0);
      const deployedHookAfter =
        (await hook.read()) as WithAddress<AggregationHookConfig>;

      expect(deployedHookBefore.address).to.equal(deployedHookAfter.address);
    });

    // generate a random config for each ownable hook type
    const ownableHooks = hookTypes
      .filter((hookType) => MUTABLE_HOOK_TYPE.includes(hookType))
      .map((hookType) => {
        return randomHookConfig(0, 1, hookType);
      });

    for (const config of ownableHooks) {
      assert(
        typeof config !== 'string',
        'Address is not an ownable hook config',
      );
      assert(
        'owner' in config,
        'Ownable hook config must have an owner property',
      );

      it(`updates owner in an existing ${config.type}`, async () => {
        // hook owned by the deployer
        config.owner = await multiProvider.getSignerAddress(chain);

        // create a new hook
        const { hook, initialHookAddress } = await createHook(config);

        // change the config owner
        config.owner = randomAddress();

        // expect 1 tx to transfer ownership
        await expectTxsAndUpdate(hook, config, 1);

        // expect the hook address to be the same
        expect(eqAddress(initialHookAddress, hook.serialize().deployedHook)).to
          .be.true;
      });

      it(`update owner in an existing ${config.type} not owned by deployer`, async () => {
        // hook owner is not the deployer
        config.owner = randomAddress();
        const originalOwner = config.owner;

        // create a new hook
        const { hook, initialHookAddress } = await createHook(config);

        // update the config owner and impersonate the original owner
        config.owner = randomAddress();
        multiProvider = await impersonateAccount(originalOwner);

        // expect 1 tx to transfer ownership
        await expectTxsAndUpdate(hook, config, 1);

        // expect the hook address to be unchanged
        expect(eqAddress(initialHookAddress, hook.serialize().deployedHook)).to
          .be.true;
      });

      it(`update owner in an existing ${config.type} not owned by deployer and no change`, async () => {
        // hook owner is not the deployer
        config.owner = randomAddress();
        const originalOwner = config.owner;

        // create a new hook
        const { hook, initialHookAddress } = await createHook(config);

        // impersonate the original owner
        multiProvider = await impersonateAccount(originalOwner);

        // expect 0 updates
        await expectTxsAndUpdate(hook, config, 0);

        // expect the hook address to be unchanged
        expect(eqAddress(initialHookAddress, hook.serialize().deployedHook)).to
          .be.true;
      });
    }
  });
});
