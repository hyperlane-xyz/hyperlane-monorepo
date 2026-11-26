import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Signer, ethers } from 'ethers';
import hre from 'hardhat';

import {
  CONTRACTS_PACKAGE_VERSION,
  DefaultHook__factory,
  DomainRoutingHook__factory,
  InterchainGasPaymaster__factory,
  MailboxClient__factory,
  MerkleTreeHook__factory,
  Ownable__factory,
  PausableHook__factory,
  ProtocolFee__factory,
  RateLimitedHook__factory,
  StaticAggregationHook__factory,
  StorageGasOracle__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  WithAddress,
  assert,
  deepCopy,
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
import {
  DEFAULT_TOKEN_DECIMALS,
  hookTypesToFilter,
  randomAddress,
  randomHookConfig,
  randomInt,
} from '../test/testUtils.js';
import { normalizeConfig } from '../utils/ism.js';

import { EvmHookModule } from './EvmHookModule.js';
import { EvmHookReader } from './EvmHookReader.js';
import {
  AggregationHookConfig,
  AmountRoutingHookConfig,
  DerivedHookConfig,
  DomainRoutingHookConfig,
  FallbackRoutingHookConfig,
  HookConfig,
  HookType,
  IgpHookConfig,
  IgpVersion,
  MUTABLE_HOOK_TYPE,
  OnchainHookType,
  PausableHookConfig,
  ProtocolFeeHookConfig,
  RateLimitedHookConfig,
} from './types.js';

chai.use(chaiAsPromised);
const { expect } = chai;

const hookTypes = Object.values(HookType);

// Lets every member through the check for an in place update, to reach the check of
// the address after the update.
class UncheckedEvmHookModule extends EvmHookModule {
  protected override async canUpdateSubHookInPlace(): Promise<boolean> {
    return true;
  }
}

describe('EvmHookModule', async () => {
  const chain = TestChainName.test4;

  let multiProvider: MultiProvider;
  let coreAddresses: CoreAddresses;
  let otherMailbox: Address;
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
    proxyFactoryAddresses = Object.keys(factoryContracts).reduce(
      (acc, key) => {
        acc[key] =
          contractsMap[chain][key as keyof ProxyFactoryFactories].address;
        return acc;
      },
      {} as Record<string, Address>,
    ) as HyperlaneAddresses<ProxyFactoryFactories>;

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
    const coreApp = await testCoreDeployer.deployApp();
    const { mailbox, proxyAdmin, validatorAnnounce, quotedCalls } =
      coreApp.getContracts(chain);
    // all the test chains share one provider, so this is a mailbox that the hooks of
    // `chain` can be bound to as well
    otherMailbox = coreApp.getContracts(TestChainName.test1).mailbox.address;

    coreAddresses = {
      mailbox: mailbox.address,
      proxyAdmin: proxyAdmin.address,
      validatorAnnounce: validatorAnnounce.address,
      quotedCalls: quotedCalls.address,
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
      coreAddresses: { ...coreAddresses, rateLimitedSender: randomAddress() },
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
        .filter((hookType) => !hookTypesToFilter.includes(hookType))
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

    it('deploys a pausable hook in the configured paused state', async () => {
      const config: PausableHookConfig = {
        owner: randomAddress(),
        type: HookType.PAUSABLE,
        paused: true,
      };

      const { initialHookAddress } = await createHook(config);
      const hook = PausableHook__factory.connect(
        initialHookAddress,
        multiProvider.getProvider(chain),
      );

      expect(await hook.paused()).to.be.true;
      expect(eqAddress(await hook.owner(), config.owner)).to.be.true;
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
    it('should update by deploying a new aggregation hook when a member changes type', async () => {
      const config: AggregationHookConfig = {
        type: HookType.AGGREGATION,
        hooks: [
          { type: HookType.MERKLE_TREE },
          { type: HookType.MAILBOX_DEFAULT },
        ],
      };

      // create a new hook
      const { hook, initialHookAddress } = await createHook(config);

      // change the type of one member
      config.hooks = [
        { type: HookType.MERKLE_TREE },
        {
          owner: randomAddress(),
          type: HookType.PROTOCOL_FEE,
          maxProtocolFee: '1',
          protocolFee: '0',
          beneficiary: randomAddress(),
        },
      ];

      // expect 0 tx to be returned, as it should deploy a new aggregation hook
      await expectTxsAndUpdate(hook, config, 0);

      // expect the hook address to be different
      expect(eqAddress(initialHookAddress, hook.serialize().deployedHook)).to.be
        .false;
    });

    it('should not update if aggregation hook includes an address of an existing hook', async () => {
      const config: AggregationHookConfig = {
        type: HookType.AGGREGATION,
        hooks: [randomHookConfig(0, 2), randomHookConfig(0, 2)],
      };

      // create a new hook
      const { hook, initialHookAddress } = await createHook(config);

      const [firstChildHook, secondSecondHook] = (
        (await hook.read()) as AggregationHookConfig
      ).hooks as DerivedHookConfig[];
      const expectedConfig = {
        ...config,
        hooks: [firstChildHook.address, secondSecondHook],
      };

      await expectTxsAndUpdate(hook, expectedConfig, 0);
      expect(initialHookAddress).to.be.equal(hook.serialize().deployedHook);
    });

    it('should not update if aggregation hook includes an address of an existing hook (depth 2)', async () => {
      const owner = await multiProvider.getSignerAddress(chain);
      const config: AggregationHookConfig = {
        type: HookType.AGGREGATION,
        hooks: [
          {
            type: HookType.AGGREGATION,
            hooks: [
              {
                type: HookType.MERKLE_TREE,
              },
              {
                owner,
                type: HookType.PROTOCOL_FEE,
                maxProtocolFee: '1',
                protocolFee: '0',
                beneficiary: owner,
              },
            ],
          },
        ],
      };

      // create a new hook
      const { hook, initialHookAddress } = await createHook(config);

      // Set the deepest hooks to their addresses
      const expectedConfig: any = deepCopy(await hook.read());
      expectedConfig.hooks[0].hooks[0] =
        expectedConfig.hooks[0].hooks[0].address;
      expectedConfig.hooks[0].hooks[1] =
        expectedConfig.hooks[0].hooks[1].address;

      await expectTxsAndUpdate(hook, expectedConfig, 0);
      expect(initialHookAddress).to.be.equal(hook.serialize().deployedHook);
    });

    it('should not update if a domain routing hook includes an address of an existing hook', async () => {
      const owner = await multiProvider.getSignerAddress(chain);
      const config: DomainRoutingHookConfig = {
        type: HookType.ROUTING,
        owner,
        domains: {
          9913371: randomHookConfig(0, 2),
          9913372: randomHookConfig(0, 2),
        },
      };
      // create a new hook
      const { hook, initialHookAddress } = await createHook(config);

      const { test1: firstHook, test2: secondHook } = (
        (await hook.read()) as DomainRoutingHookConfig
      ).domains;
      const expectedConfig = {
        ...config,
        domains: {
          test1: (firstHook as DerivedHookConfig).address,
          test2: secondHook,
        },
      };

      await expectTxsAndUpdate(hook, expectedConfig, 0);
      expect(eqAddress(initialHookAddress, hook.serialize().deployedHook)).to.be
        .true;
    });

    it('should not update if a domain routing hook includes an address of an existing hook (depth 2)', async () => {
      const owner = await multiProvider.getSignerAddress(chain);
      const config: DomainRoutingHookConfig = {
        type: HookType.ROUTING,
        owner,
        domains: {
          9913371: {
            type: HookType.AGGREGATION,
            hooks: [
              {
                type: HookType.MERKLE_TREE,
              },
              {
                owner,
                type: HookType.PROTOCOL_FEE,
                maxProtocolFee: '1',
                protocolFee: '0',
                beneficiary: owner,
              },
            ],
          },
          9913372: {
            type: HookType.AGGREGATION,
            hooks: [
              {
                type: HookType.MERKLE_TREE,
              },
              {
                owner,
                type: HookType.PROTOCOL_FEE,
                maxProtocolFee: '1',
                protocolFee: '0',
                beneficiary: owner,
              },
            ],
          },
        },
      };
      // create a new hook
      const { hook, initialHookAddress } = await createHook(config);

      // Set the deepest hooks to their addresses
      const expectedConfig: any = deepCopy(await hook.read());
      expectedConfig.domains.test1.hooks[0] =
        expectedConfig.domains.test1.hooks[0].address;
      expectedConfig.domains.test2.hooks[0] =
        expectedConfig.domains.test2.hooks[0].address;

      await expectTxsAndUpdate(hook, expectedConfig, 0);
      expect(eqAddress(initialHookAddress, hook.serialize().deployedHook)).to.be
        .true;
    });

    it('should not update if a fallback routing hook includes an address of an existing hook', async () => {
      const owner = await multiProvider.getSignerAddress(chain);
      const config: FallbackRoutingHookConfig = {
        type: HookType.FALLBACK_ROUTING,
        owner,
        domains: {
          9913371: randomHookConfig(0, 2),
          9913372: randomHookConfig(0, 2),
        },
        fallback: randomHookConfig(0, 2),
      };
      // create a new hook
      const { hook, initialHookAddress } = await createHook(config);

      const derivedHook = (await hook.read()) as FallbackRoutingHookConfig;
      const { test1: firstHook, test2: secondHook } = derivedHook.domains;

      const expectedConfig = {
        ...config,
        domains: {
          test1: (firstHook as DerivedHookConfig).address,
          test2: secondHook,
        },
        fallback: (derivedHook.fallback as DerivedHookConfig).address,
      };

      await expectTxsAndUpdate(hook, expectedConfig, 0);
      expect(eqAddress(initialHookAddress, hook.serialize().deployedHook)).to.be
        .true;
    });

    it('should not update if a fallback routing hook includes an address of an existing hook (depth 2)', async () => {
      const owner = await multiProvider.getSignerAddress(chain);
      const config: FallbackRoutingHookConfig = {
        type: HookType.FALLBACK_ROUTING,
        owner,
        domains: {
          9913371: randomHookConfig(0, 2),
          9913372: randomHookConfig(0, 2),
        },
        fallback: {
          type: HookType.AGGREGATION,
          hooks: [
            {
              type: HookType.MERKLE_TREE,
            },
            {
              owner,
              type: HookType.PROTOCOL_FEE,
              maxProtocolFee: '1',
              protocolFee: '0',
              beneficiary: owner,
            },
          ],
        },
      };
      // create a new hook
      const { hook, initialHookAddress } = await createHook(config);

      const derivedHook: any = await hook.read();

      const expectedConfig: FallbackRoutingHookConfig = {
        ...derivedHook,
        fallback: {
          type: HookType.AGGREGATION,
          hooks: [
            derivedHook.fallback.hooks[0],
            derivedHook.fallback.hooks[1].address,
          ],
        },
      };

      await expectTxsAndUpdate(hook, expectedConfig, 0);
      expect(initialHookAddress).to.be.equal(hook.serialize().deployedHook);
    });

    it('should not update if a amount routing hook includes an address of an existing hook', async () => {
      const config: AmountRoutingHookConfig = {
        type: HookType.AMOUNT_ROUTING,
        threshold: 1,
        lowerHook: randomHookConfig(0, 2),
        upperHook: randomHookConfig(0, 2),
      };
      // create a new hook
      const { hook, initialHookAddress } = await createHook(config);

      const derivedHook = (await hook.read()) as AmountRoutingHookConfig;
      const { lowerHook, upperHook } = derivedHook;

      const expectedConfig = {
        ...config,
        lowerHook: (lowerHook as DerivedHookConfig).address,
        upperHook: upperHook,
      };

      await expectTxsAndUpdate(hook, expectedConfig, 0);
      expect(eqAddress(initialHookAddress, hook.serialize().deployedHook)).to.be
        .true;
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

    it('should not update IGP only because igpVersion is legacy', async () => {
      const config = await createDeployerOwnedIgpHookConfig();
      const { hook } = await createHook(config);

      await expectTxsAndUpdate(
        hook,
        { ...config, igpVersion: IgpVersion.Legacy },
        0,
      );
    });

    it('should not update routing hooks only because nested IGP is legacy', async () => {
      const igpConfig = await createDeployerOwnedIgpHookConfig();
      const config: FallbackRoutingHookConfig = {
        owner: await multiProvider.getSignerAddress(chain),
        domains: {
          [TestChainName.test1]: {
            type: HookType.AGGREGATION,
            hooks: [{ type: HookType.MERKLE_TREE }, igpConfig],
          },
        },
        type: HookType.FALLBACK_ROUTING,
        fallback: { type: HookType.MERKLE_TREE },
      };
      const { hook } = await createHook(config);
      const legacyConfig = deepCopy(config);
      (
        (legacyConfig.domains[TestChainName.test1] as AggregationHookConfig)
          .hooks[1] as IgpHookConfig
      ).igpVersion = IgpVersion.Legacy;

      await expectTxsAndUpdate(hook, legacyConfig, 0);
    });

    it('should add quote signers to IGP', async () => {
      const config = await createDeployerOwnedIgpHookConfig();
      config.contractVersion = CONTRACTS_PACKAGE_VERSION;

      // create a new hook
      const { hook } = await createHook(config);

      // add quote signers (contractVersion needed to confirm IGP supports them)
      config.quoteSigners = [randomAddress(), randomAddress()];

      // expect 2 txs to add quote signers
      await expectTxsAndUpdate(hook, config, 2);
    });

    it('should remove quote signers from IGP', async () => {
      const signerA = randomAddress();
      const signerB = randomAddress();
      const config = await createDeployerOwnedIgpHookConfig();
      config.quoteSigners = [signerA, signerB];

      // create a new hook with signers
      const { hook } = await createHook(config);

      // remove one signer
      config.quoteSigners = [signerA];

      // expect 1 tx to remove a signer
      await expectTxsAndUpdate(hook, config, 1);
    });

    it('should deploy IGP with quote signers and read them back', async () => {
      const signerA = randomAddress();
      const signerB = randomAddress();
      const config = await createDeployerOwnedIgpHookConfig();
      config.quoteSigners = [signerA, signerB];

      const { hook } = await createHook(config);
      const readConfig = normalizeConfig(await hook.read());

      expect(readConfig.quoteSigners).to.have.lengthOf(2);
      expect(readConfig.quoteSigners).to.include(signerA.toLowerCase());
      expect(readConfig.quoteSigners).to.include(signerB.toLowerCase());
    });

    it('should not update IGP if quote signers unchanged', async () => {
      const signerAddr = randomAddress();
      const config = await createDeployerOwnedIgpHookConfig();
      config.quoteSigners = [signerAddr];

      const { hook } = await createHook(config);

      // same config, no updates
      await expectTxsAndUpdate(hook, config, 0);
    });

    it('should not remove existing quote signers when target omits the field', async () => {
      const config = await createDeployerOwnedIgpHookConfig();
      config.contractVersion = CONTRACTS_PACKAGE_VERSION;
      config.quoteSigners = [randomAddress()];

      const { hook } = await createHook(config);

      // omit quoteSigners from target — should not generate remove txs
      delete config.quoteSigners;

      // expect 0 txs since omitting quoteSigners means "don't change"
      await expectTxsAndUpdate(hook, config, 0);
    });

    it('should reject quote signers for legacy IGP configs', async () => {
      const config = await createDeployerOwnedIgpHookConfig();
      const { hook } = await createHook(config);
      const legacyTarget = {
        ...config,
        igpVersion: IgpVersion.Legacy,
        quoteSigners: [randomAddress()],
      };

      try {
        await hook.update(legacyTarget);
        throw new Error('Expected legacy IGP quote signer update to fail');
      } catch (error: unknown) {
        assert(error instanceof Error, 'Expected Error');
        expect(error.message).to.include(
          'IGP quoteSigners require contract version >= 11.3.0',
        );
      }
    });

    const randomTokenOracleConfig = (withTypicalCost = false) =>
      Object.fromEntries(
        testChains.map((c) => [
          c,
          {
            tokenExchangeRate: randomInt(1234567891234).toString(),
            gasPrice: randomInt(1234567891234).toString(),
            tokenDecimals: DEFAULT_TOKEN_DECIMALS,
            ...(withTypicalCost
              ? {
                  typicalCost: {
                    handleGasAmount: 50_000,
                    totalGasAmount: 200_000,
                    totalUsdCost: 1,
                  },
                }
              : {}),
          },
        ]),
      );

    it('should deploy IGP with token gas oracles and wire them on-chain', async () => {
      const feeToken = randomAddress();
      const config = await createDeployerOwnedIgpHookConfig();
      config.tokenOracleConfig = { [feeToken]: randomTokenOracleConfig() };

      const { hook } = await createHook(config);

      // The token oracle mapping is read back from chain (not derivable via the
      // reader), so assert it directly: a dedicated oracle is wired per remote.
      const igp = InterchainGasPaymaster__factory.connect(
        hook.serialize().deployedHook,
        multiProvider.getProvider(chain),
      );
      const oracles = await Promise.all(
        testChains.map((c) =>
          igp.tokenGasOracles(feeToken, multiProvider.getDomainId(c)),
        ),
      );
      for (const oracle of oracles) {
        expect(eqAddress(oracle, ethers.constants.AddressZero)).to.be.false;
      }
      // All destinations of a fee token share a single oracle instance.
      expect(oracles.every((o) => eqAddress(o, oracles[0]))).to.be.true;
    });

    it('should set token gas oracles on update', async () => {
      const config = await createDeployerOwnedIgpHookConfig();
      config.contractVersion = CONTRACTS_PACKAGE_VERSION;
      const { hook } = await createHook(config);

      // add a token oracle config; oracle is deployed eagerly, leaving a single
      // setTokenGasOracles tx to wire the mapping.
      config.tokenOracleConfig = {
        [randomAddress()]: randomTokenOracleConfig(true),
      };
      await expectTxsAndUpdate(hook, config, 1);

      // re-applying the same config is a no-op (mapping already wired on-chain)
      await expectTxsAndUpdate(hook, config, 0);
    });

    it('should reject token gas oracle remotes without native gas config', async () => {
      const config = await createDeployerOwnedIgpHookConfig();
      config.contractVersion = CONTRACTS_PACKAGE_VERSION;
      const { hook } = await createHook(config);

      const target = deepCopy(config);
      const [remoteWithoutNativeConfig] = testChains;
      delete target.overhead[remoteWithoutNativeConfig];
      target.tokenOracleConfig = {
        [randomAddress()]: randomTokenOracleConfig(),
      };

      try {
        await hook.update(target);
        throw new Error('Expected token oracle remote validation to fail');
      } catch (error: unknown) {
        assert(error instanceof Error, 'Expected Error');
        expect(error.message).to.include(
          `includes remotes without native gas oracle config: ${remoteWithoutNativeConfig}`,
        );
      }
    });

    it('should reject token gas oracles for legacy IGP configs', async () => {
      const config = await createDeployerOwnedIgpHookConfig();
      const { hook } = await createHook(config);
      const legacyTarget = {
        ...config,
        igpVersion: IgpVersion.Legacy,
        tokenOracleConfig: { [randomAddress()]: randomTokenOracleConfig() },
      };

      try {
        await hook.update(legacyTarget);
        throw new Error('Expected legacy IGP token oracle update to fail');
      } catch (error: unknown) {
        assert(error instanceof Error, 'Expected Error');
        expect(error.message).to.include(
          'IGP tokenOracleConfig requires contract version >= 11.3.0',
        );
      }
    });

    it('should not upgrade IGP when contractVersion is not in config', async () => {
      const config = await createDeployerOwnedIgpHookConfig();
      const { hook, initialHookAddress } = await createHook(config);

      // no contractVersion in config, should produce no upgrade txs
      await expectTxsAndUpdate(hook, config, 0);
      expect(hook.serialize().deployedHook).to.equal(initialHookAddress);
    });

    it('should not upgrade IGP when contractVersion matches', async () => {
      const config = await createDeployerOwnedIgpHookConfig();
      config.contractVersion = CONTRACTS_PACKAGE_VERSION;

      const { hook, initialHookAddress } = await createHook(config);

      // version matches, no upgrade needed
      await expectTxsAndUpdate(hook, config, 0);
      expect(hook.serialize().deployedHook).to.equal(initialHookAddress);
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

    it('should update maxCapacity on RateLimitedHook in place via setRefillRate', async () => {
      const owner = await multiProvider.getSignerAddress(chain);
      const config: RateLimitedHookConfig = {
        owner,
        type: HookType.RATE_LIMITED,
        maxCapacity: (86400n * 100n).toString(),
        duration: 86400n,
      };

      const { hook, initialHookAddress } = await createHook(config);

      config.maxCapacity = (86400n * 200n).toString();

      // exactly 1 tx — setRefillRate, not a redeploy
      await expectTxsAndUpdate(hook, config, 1);

      // address unchanged: in-place update, not a new deployment
      expect(hook.serialize().deployedHook).to.equal(initialHookAddress);
    });

    it('redeploys a new RateLimitedHook on duration change (immutable)', async () => {
      const owner = await multiProvider.getSignerAddress(chain);
      const config: RateLimitedHookConfig = {
        owner,
        type: HookType.RATE_LIMITED,
        maxCapacity: '86400',
        duration: 86400n,
      };

      const { hook, initialHookAddress } = await createHook(config);

      // duration is immutable on-chain; changing it must redeploy a fresh hook.
      // keep maxCapacity a multiple of the new duration (schema constraint).
      config.duration = 3600n;
      config.maxCapacity = '3600';

      // update() redeploys internally and emits no txs
      await expectTxsAndUpdate(hook, config, 0);

      // different contract address — redeployed
      expect(eqAddress(initialHookAddress, hook.serialize().deployedHook)).to.be
        .false;

      const rateLimitedHook = RateLimitedHook__factory.connect(
        hook.serialize().deployedHook,
        multiProvider.getProvider(chain),
      );
      expect((await rateLimitedHook.DURATION()).toString()).to.equal('3600');
    });

    for (const type of [HookType.ROUTING, HookType.FALLBACK_ROUTING]) {
      beforeEach(() => {
        exampleRoutingConfig.type = type;
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
        const { hook, initialHookAddress } =
          await createHook(exampleRoutingConfig);

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
        const { hook, initialHookAddress } =
          await createHook(exampleRoutingConfig);

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
        const { hook, initialHookAddress } =
          await createHook(exampleRoutingConfig);

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
      const { hook, initialHookAddress } = await createHook(hookConfig);

      // Read the deployed config and use the child hook's address for update
      // This follows the same pattern as other similar tests
      const deployedHook =
        (await hook.read()) as WithAddress<AggregationHookConfig>;
      const childHook = deployedHook.hooks[0] as DerivedHookConfig;
      const expectedConfig: AggregationHookConfig = {
        type: HookType.AGGREGATION,
        hooks: [childHook.address],
      };

      // expect 0 updates when using the deployed hook's address
      await expectTxsAndUpdate(hook, expectedConfig, 0);
      expect(initialHookAddress).to.equal(hook.serialize().deployedHook);
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
        const originalOwner = randomAddress();
        config.owner = originalOwner;

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
        const originalOwner = randomAddress();
        config.owner = originalOwner;

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

    describe('aggregation hook in-place updates', async () => {
      const ownableInterface = Ownable__factory.createInterface();
      let signerAddress: Address;

      before(async () => {
        // earlier tests replace the module's signer with an impersonated account
        multiProvider = MultiProvider.createTestMultiProvider({ signer });
        signerAddress = await multiProvider.getSignerAddress(chain);
      });

      function pausableMember(
        owner: Address,
        paused = false,
      ): PausableHookConfig {
        return { owner, paused, type: HookType.PAUSABLE };
      }

      function rateLimitedMember(
        owner: Address,
        maxCapacity = (86400n * 100n).toString(),
        duration = 86400n,
      ): RateLimitedHookConfig {
        return { owner, maxCapacity, duration, type: HookType.RATE_LIMITED };
      }

      function aggregationOf(...hooks: HookConfig[]): AggregationHookConfig {
        return { type: HookType.AGGREGATION, hooks };
      }

      async function hooksOf(aggregation: Address): Promise<Address[]> {
        return StaticAggregationHook__factory.connect(
          aggregation,
          multiProvider.getProvider(chain),
        ).hooks(hre.ethers.constants.AddressZero);
      }

      // the member addresses of an aggregation hook keyed by the hook type
      async function membersOf(
        aggregation: Address,
      ): Promise<Record<string, Address>> {
        const reader = new EvmHookReader(multiProvider, chain);
        const members: Record<string, Address> = {};
        for (const address of await hooksOf(aggregation)) {
          members[(await reader.deriveHookConfig(address)).type] = address;
        }
        return members;
      }

      // an address with code that reports `type` as its hook type and is nothing else
      async function hookTypeStub(type: OnchainHookType): Promise<Address> {
        const address = randomAddress();
        await hre.ethers.provider.send('hardhat_setCode', [
          address,
          `0x60${type.toString(16).padStart(2, '0')}60005260206000f3`,
        ]);
        return address;
      }

      function memberOfType(
        members: Record<string, Address>,
        type: HookType,
      ): Address {
        const address = members[type];
        assert(address, `Missing ${type} member`);
        return address;
      }

      async function sendTxs(
        txs: Awaited<ReturnType<EvmHookModule['update']>>,
      ) {
        for (const tx of txs) {
          await multiProvider.sendTransaction(chain, tx);
        }
      }

      async function contractCreationsSince(
        blockNumber: number,
      ): Promise<number> {
        const provider = multiProvider.getProvider(chain);
        const latest = await provider.getBlockNumber();
        let creations = 0;
        for (let number = blockNumber + 1; number <= latest; number++) {
          const block = await provider.getBlockWithTransactions(number);
          for (const tx of block.transactions) {
            const receipt = await provider.getTransactionReceipt(tx.hash);
            if (receipt.contractAddress) creations++;
          }
        }
        return creations;
      }

      // a module on the deployed hook that has not read it yet
      function freshModule(hook: EvmHookModule, config: HookConfig) {
        return new EvmHookModule(multiProvider, {
          chain,
          config,
          addresses: hook.serialize(),
        });
      }

      it('updates only the owner of a rate limited member in place', async () => {
        const pausableOwner = randomAddress();
        const newOwner = randomAddress();
        const { hook, initialHookAddress } = await createHook(
          aggregationOf(
            pausableMember(pausableOwner),
            rateLimitedMember(signerAddress),
            { type: HookType.MAILBOX_DEFAULT },
          ),
        );
        const membersBefore = await membersOf(initialHookAddress);
        const rateLimited = memberOfType(membersBefore, HookType.RATE_LIMITED);

        const target = aggregationOf(
          pausableMember(pausableOwner),
          rateLimitedMember(newOwner),
          { type: HookType.MAILBOX_DEFAULT },
        );
        const txs = await hook.update(target);

        expect(txs).to.have.length(1);
        expect(txs[0].to).to.equal(rateLimited);
        expect(txs[0].data).to.equal(
          ownableInterface.encodeFunctionData('transferOwnership(address)', [
            newOwner,
          ]),
        );
        await sendTxs(txs);

        expect(hook.serialize().deployedHook).to.equal(initialHookAddress);
        expect(await membersOf(initialHookAddress)).to.deep.equal(
          membersBefore,
        );
        const provider = multiProvider.getProvider(chain);
        expect(
          eqAddress(
            await RateLimitedHook__factory.connect(
              rateLimited,
              provider,
            ).owner(),
            newOwner,
          ),
        ).to.be.true;
        expect(
          eqAddress(
            await PausableHook__factory.connect(
              memberOfType(membersBefore, HookType.PAUSABLE),
              provider,
            ).owner(),
            pausableOwner,
          ),
        ).to.be.true;

        expect(await freshModule(hook, target).update(target)).to.have.length(
          0,
        );
      });

      it('updates the paused state and owner of a pausable member in place', async () => {
        const newOwner = randomAddress();
        const { hook, initialHookAddress } = await createHook(
          aggregationOf(pausableMember(signerAddress), {
            type: HookType.MERKLE_TREE,
          }),
        );
        const membersBefore = await membersOf(initialHookAddress);

        const txs = await hook.update(
          aggregationOf(pausableMember(newOwner, true), {
            type: HookType.MERKLE_TREE,
          }),
        );
        expect(txs).to.have.length(2);
        await sendTxs(txs);

        expect(hook.serialize().deployedHook).to.equal(initialHookAddress);
        expect(await membersOf(initialHookAddress)).to.deep.equal(
          membersBefore,
        );
        const pausable = PausableHook__factory.connect(
          memberOfType(membersBefore, HookType.PAUSABLE),
          multiProvider.getProvider(chain),
        );
        expect(await pausable.paused()).to.be.true;
        expect(eqAddress(await pausable.owner(), newOwner)).to.be.true;
      });

      it('updates the capacity of a rate limited member in place', async () => {
        const { hook, initialHookAddress } = await createHook(
          aggregationOf(rateLimitedMember(signerAddress), {
            type: HookType.MAILBOX_DEFAULT,
          }),
        );
        const membersBefore = await membersOf(initialHookAddress);

        const txs = await hook.update(
          aggregationOf(
            rateLimitedMember(signerAddress, (86400n * 200n).toString()),
            { type: HookType.MAILBOX_DEFAULT },
          ),
        );
        expect(txs).to.have.length(1);
        await sendTxs(txs);

        expect(hook.serialize().deployedHook).to.equal(initialHookAddress);
        expect(await membersOf(initialHookAddress)).to.deep.equal(
          membersBefore,
        );
        const rateLimited = RateLimitedHook__factory.connect(
          memberOfType(membersBefore, HookType.RATE_LIMITED),
          multiProvider.getProvider(chain),
        );
        expect((await rateLimited.maxCapacity()).toString()).to.equal(
          (86400n * 200n).toString(),
        );
      });

      it('keeps the members that cannot change when another member is updated', async () => {
        const { hook, initialHookAddress } = await createHook(
          aggregationOf(
            { type: HookType.MERKLE_TREE },
            { type: HookType.MAILBOX_DEFAULT },
            pausableMember(signerAddress),
          ),
        );
        const membersBefore = await membersOf(initialHookAddress);

        const txs = await hook.update(
          aggregationOf(
            { type: HookType.MERKLE_TREE },
            { type: HookType.MAILBOX_DEFAULT },
            pausableMember(signerAddress, true),
          ),
        );
        expect(txs).to.have.length(1);
        await sendTxs(txs);

        expect(hook.serialize().deployedHook).to.equal(initialHookAddress);
        expect(await membersOf(initialHookAddress)).to.deep.equal(
          membersBefore,
        );
      });

      it('updates the IGP member of a merkle tree and IGP aggregation in place', async () => {
        const igp = await createDeployerOwnedIgpHookConfig();
        const { hook, initialHookAddress } = await createHook(
          aggregationOf({ type: HookType.MERKLE_TREE }, igp),
        );
        const membersBefore = await membersOf(initialHookAddress);
        const newBeneficiary = randomAddress();

        igp.beneficiary = newBeneficiary;
        const txs = await hook.update(
          aggregationOf({ type: HookType.MERKLE_TREE }, igp),
        );
        expect(txs).to.have.length(1);
        expect(txs[0].to).to.equal(
          memberOfType(membersBefore, HookType.INTERCHAIN_GAS_PAYMASTER),
        );
        await sendTxs(txs);

        expect(hook.serialize().deployedHook).to.equal(initialHookAddress);
        expect(await membersOf(initialHookAddress)).to.deep.equal(
          membersBefore,
        );
        expect(
          eqAddress(
            await InterchainGasPaymaster__factory.connect(
              memberOfType(membersBefore, HookType.INTERCHAIN_GAS_PAYMASTER),
              multiProvider.getProvider(chain),
            ).beneficiary(),
            newBeneficiary,
          ),
        ).to.be.true;
      });

      it('applies no transactions when the config is unchanged', async () => {
        const config = aggregationOf(
          pausableMember(signerAddress),
          rateLimitedMember(signerAddress),
          { type: HookType.MAILBOX_DEFAULT },
        );
        const { hook, initialHookAddress } = await createHook(config);

        await expectTxsAndUpdate(hook, config, 0);
        expect(hook.serialize().deployedHook).to.equal(initialHookAddress);
      });

      it('redeploys the members and the aggregation when the duration of a rate limited member changes', async () => {
        const pausableOwner = randomAddress();
        const { hook, initialHookAddress } = await createHook(
          aggregationOf(
            pausableMember(pausableOwner),
            rateLimitedMember(signerAddress),
            { type: HookType.MAILBOX_DEFAULT },
          ),
        );
        const fromBlock = await multiProvider
          .getProvider(chain)
          .getBlockNumber();

        // maxCapacity has to be a multiple of the duration
        await expectTxsAndUpdate(
          hook,
          aggregationOf(
            pausableMember(pausableOwner),
            rateLimitedMember(signerAddress, '3600', 3600n),
            { type: HookType.MAILBOX_DEFAULT },
          ),
          0,
        );

        expect(hook.serialize().deployedHook).to.not.equal(initialHookAddress);
        // a pausable, a rate limited and a default hook; nothing is deployed
        // while the members are checked for an in place update
        expect(await contractCreationsSince(fromBlock)).to.equal(3);
        const rateLimited = RateLimitedHook__factory.connect(
          memberOfType(
            await membersOf(hook.serialize().deployedHook),
            HookType.RATE_LIMITED,
          ),
          multiProvider.getProvider(chain),
        );
        expect((await rateLimited.DURATION()).toString()).to.equal('3600');
      });

      it('redeploys the aggregation when the max protocol fee and the duration of two members change', async () => {
        const owner = signerAddress;
        const { hook, initialHookAddress } = await createHook(
          aggregationOf(
            {
              owner,
              type: HookType.PROTOCOL_FEE,
              maxProtocolFee: '10',
              protocolFee: '1',
              beneficiary: owner,
            },
            rateLimitedMember(owner),
          ),
        );
        const fromBlock = await multiProvider
          .getProvider(chain)
          .getBlockNumber();

        // the protocol fee hook would be redeployed by its own update, and the
        // rate limited hook cannot be updated in place
        await expectTxsAndUpdate(
          hook,
          aggregationOf(
            {
              owner,
              type: HookType.PROTOCOL_FEE,
              maxProtocolFee: '20',
              protocolFee: '1',
              beneficiary: owner,
            },
            rateLimitedMember(owner, '3600', 3600n),
          ),
          0,
        );

        expect(hook.serialize().deployedHook).to.not.equal(initialHookAddress);
        expect(await contractCreationsSince(fromBlock)).to.equal(2);
        const protocolFee = ProtocolFee__factory.connect(
          memberOfType(
            await membersOf(hook.serialize().deployedHook),
            HookType.PROTOCOL_FEE,
          ),
          multiProvider.getProvider(chain),
        );
        expect((await protocolFee.MAX_PROTOCOL_FEE()).toString()).to.equal(
          '20',
        );
      });

      it('redeploys the aggregation when the max protocol fee of a member changes', async () => {
        const owner = signerAddress;
        const { hook, initialHookAddress } = await createHook(
          aggregationOf(
            {
              owner,
              type: HookType.PROTOCOL_FEE,
              maxProtocolFee: '10',
              protocolFee: '1',
              beneficiary: owner,
            },
            { type: HookType.MAILBOX_DEFAULT },
          ),
        );
        const fromBlock = await multiProvider
          .getProvider(chain)
          .getBlockNumber();

        await expectTxsAndUpdate(
          hook,
          aggregationOf(
            {
              owner,
              type: HookType.PROTOCOL_FEE,
              maxProtocolFee: '20',
              protocolFee: '1',
              beneficiary: owner,
            },
            { type: HookType.MAILBOX_DEFAULT },
          ),
          0,
        );

        expect(hook.serialize().deployedHook).to.not.equal(initialHookAddress);
        // a protocol fee and a default hook
        expect(await contractCreationsSince(fromBlock)).to.equal(2);
      });

      it('redeploys the aggregation when the fallback of a fallback routing member changes', async () => {
        function fallbackRoutingMember(
          fallback: HookConfig,
        ): FallbackRoutingHookConfig {
          return {
            owner: signerAddress,
            type: HookType.FALLBACK_ROUTING,
            domains: {},
            fallback,
          };
        }
        const { hook, initialHookAddress } = await createHook(
          aggregationOf(
            fallbackRoutingMember({ type: HookType.MERKLE_TREE }),
            pausableMember(signerAddress),
          ),
        );
        const fromBlock = await multiProvider
          .getProvider(chain)
          .getBlockNumber();

        await expectTxsAndUpdate(
          hook,
          aggregationOf(
            fallbackRoutingMember({ type: HookType.MAILBOX_DEFAULT }),
            pausableMember(signerAddress),
          ),
          0,
        );

        expect(hook.serialize().deployedHook).to.not.equal(initialHookAddress);
        // a default hook as the fallback, the routing hook and a pausable hook
        expect(await contractCreationsSince(fromBlock)).to.equal(3);
      });

      it('redeploys the aggregation when a member is added', async () => {
        const { hook, initialHookAddress } = await createHook(
          aggregationOf(pausableMember(signerAddress), {
            type: HookType.MAILBOX_DEFAULT,
          }),
        );

        await expectTxsAndUpdate(
          hook,
          aggregationOf(
            pausableMember(signerAddress),
            { type: HookType.MAILBOX_DEFAULT },
            { type: HookType.MERKLE_TREE },
          ),
          0,
        );

        expect(hook.serialize().deployedHook).to.not.equal(initialHookAddress);
      });

      it('redeploys the aggregation when a member changes its type', async () => {
        const { hook, initialHookAddress } = await createHook(
          aggregationOf(pausableMember(signerAddress), {
            type: HookType.MAILBOX_DEFAULT,
          }),
        );

        await expectTxsAndUpdate(
          hook,
          aggregationOf(pausableMember(signerAddress), {
            type: HookType.MERKLE_TREE,
          }),
          0,
        );

        expect(hook.serialize().deployedHook).to.not.equal(initialHookAddress);
      });

      it('redeploys the aggregation when members of the same type cannot be told apart', async () => {
        const otherOwner = randomAddress();
        const { hook, initialHookAddress } = await createHook(
          aggregationOf(
            pausableMember(signerAddress),
            pausableMember(otherOwner),
          ),
        );

        await expectTxsAndUpdate(
          hook,
          aggregationOf(
            pausableMember(randomAddress()),
            pausableMember(otherOwner),
          ),
          0,
        );

        expect(hook.serialize().deployedHook).to.not.equal(initialHookAddress);
      });

      it('keeps a member given as the address of a deployed member', async () => {
        const newOwner = randomAddress();
        const { hook, initialHookAddress } = await createHook(
          aggregationOf(
            pausableMember(randomAddress()),
            rateLimitedMember(signerAddress),
            { type: HookType.MAILBOX_DEFAULT },
          ),
        );
        const membersBefore = await membersOf(initialHookAddress);

        const txs = await hook.update(
          aggregationOf(
            memberOfType(membersBefore, HookType.PAUSABLE),
            rateLimitedMember(newOwner),
            { type: HookType.MAILBOX_DEFAULT },
          ),
        );
        expect(txs).to.have.length(1);
        expect(txs[0].to).to.equal(
          memberOfType(membersBefore, HookType.RATE_LIMITED),
        );
        await sendTxs(txs);

        expect(hook.serialize().deployedHook).to.equal(initialHookAddress);
        expect(await membersOf(initialHookAddress)).to.deep.equal(
          membersBefore,
        );
      });

      it('redeploys the aggregation when a member is given as the address of a hook that is not a member', async () => {
        const pausableOwner = randomAddress();
        const { initialHookAddress: otherPausable } = await createHook(
          pausableMember(randomAddress()),
        );
        const { hook, initialHookAddress } = await createHook(
          aggregationOf(
            pausableMember(pausableOwner),
            rateLimitedMember(signerAddress),
          ),
        );
        const membersBefore = await membersOf(initialHookAddress);

        await expectTxsAndUpdate(
          hook,
          aggregationOf(otherPausable, rateLimitedMember(signerAddress)),
          0,
        );

        expect(hook.serialize().deployedHook).to.not.equal(initialHookAddress);
        expect(
          eqAddress(
            await PausableHook__factory.connect(
              memberOfType(membersBefore, HookType.PAUSABLE),
              multiProvider.getProvider(chain),
            ).owner(),
            pausableOwner,
          ),
        ).to.be.true;
      });

      it('deploys nothing for the members before it knows that all of them can be updated in place', async () => {
        const owner = signerAddress;
        function routingMember(
          domainHook: HookConfig,
        ): DomainRoutingHookConfig {
          return {
            owner,
            type: HookType.ROUTING,
            domains: { [TestChainName.test1]: domainHook },
          };
        }
        const { hook, initialHookAddress } = await createHook(
          aggregationOf(
            routingMember({ type: HookType.MERKLE_TREE }),
            rateLimitedMember(owner),
          ),
        );
        const fromBlock = await multiProvider
          .getProvider(chain)
          .getBlockNumber();

        // the routing hook is updated in place by deploying the hook of its domain,
        // which has to wait for the rate limited hook, that has to be redeployed
        await expectTxsAndUpdate(
          hook,
          aggregationOf(
            routingMember({ type: HookType.MAILBOX_DEFAULT }),
            rateLimitedMember(owner, '3600', 3600n),
          ),
          0,
        );

        expect(hook.serialize().deployedHook).to.not.equal(initialHookAddress);
        // a routing hook, its domain hook and a rate limited hook
        expect(await contractCreationsSince(fromBlock)).to.equal(3);
      });

      it('redeploys the aggregation when updating a member in place changes its address', async () => {
        const owner = signerAddress;
        function protocolFeeMember(
          maxProtocolFee: string,
        ): ProtocolFeeHookConfig {
          return {
            owner,
            type: HookType.PROTOCOL_FEE,
            maxProtocolFee,
            protocolFee: '1',
            beneficiary: owner,
          };
        }
        const config = aggregationOf(protocolFeeMember('10'), {
          type: HookType.MAILBOX_DEFAULT,
        });
        const { hook, initialHookAddress } = await createHook(config);
        const unchecked = new UncheckedEvmHookModule(multiProvider, {
          chain,
          config,
          addresses: hook.serialize(),
        });

        const txs = await unchecked.update(
          aggregationOf(protocolFeeMember('20'), {
            type: HookType.MAILBOX_DEFAULT,
          }),
        );

        expect(txs).to.have.length(0);
        const deployedHook = unchecked.serialize().deployedHook;
        expect(deployedHook).to.not.equal(initialHookAddress);
        const protocolFee = ProtocolFee__factory.connect(
          memberOfType(await membersOf(deployedHook), HookType.PROTOCOL_FEE),
          multiProvider.getProvider(chain),
        );
        expect((await protocolFee.MAX_PROTOCOL_FEE()).toString()).to.equal(
          '20',
        );
      });

      interface BoundHookCase {
        name: string;
        type: HookType;
        member: HookConfig;
        deploy: (mailbox: Address) => Promise<Address>;
      }
      const boundHookCases: BoundHookCase[] = [
        {
          name: 'merkle tree',
          type: HookType.MERKLE_TREE,
          member: { type: HookType.MERKLE_TREE },
          deploy: async (mailbox) =>
            (await new MerkleTreeHook__factory(signer).deploy(mailbox)).address,
        },
        {
          name: 'default',
          type: HookType.MAILBOX_DEFAULT,
          member: { type: HookType.MAILBOX_DEFAULT },
          deploy: async (mailbox) =>
            (await new DefaultHook__factory(signer).deploy(mailbox)).address,
        },
      ];
      for (const c of boundHookCases) {
        it(`redeploys the aggregation when its ${c.name} member is bound to another mailbox`, async () => {
          const bound = await c.deploy(otherMailbox);
          const provider = multiProvider.getProvider(chain);
          expect(
            eqAddress(
              await MailboxClient__factory.connect(bound, provider).mailbox(),
              coreAddresses.mailbox,
            ),
          ).to.be.false;
          const { hook, initialHookAddress } = await createHook(
            aggregationOf(bound, pausableMember(signerAddress)),
          );

          // the member is the same as far as its config goes
          await expectTxsAndUpdate(
            hook,
            aggregationOf(c.member, pausableMember(signerAddress, true)),
            0,
          );

          const deployedHook = hook.serialize().deployedHook;
          expect(deployedHook).to.not.equal(initialHookAddress);
          const member = memberOfType(await membersOf(deployedHook), c.type);
          expect(member).to.not.equal(bound);
          expect(
            eqAddress(
              await MailboxClient__factory.connect(member, provider).mailbox(),
              coreAddresses.mailbox,
            ),
          ).to.be.true;
        });
      }

      interface ReferencedHookCase {
        name: string;
        type: OnchainHookType;
        asMember: (address: Address) => HookConfig;
      }
      const referencedHookCases: ReferencedHookCase[] = [
        {
          name: 'a CCTP hook given as an address',
          type: OnchainHookType.CCTP,
          asMember: (address) => address,
        },
        {
          name: 'a CCTP hook given as a config',
          type: OnchainHookType.CCTP,
          asMember: (address) => ({ type: HookType.CCTP, address }),
        },
        {
          name: 'a predicate hook given as an address',
          type: OnchainHookType.PREDICATE_ROUTER_WRAPPER,
          asMember: (address) => address,
        },
        {
          name: 'a predicate hook given as a config',
          type: OnchainHookType.PREDICATE_ROUTER_WRAPPER,
          asMember: (address) => ({ type: HookType.PREDICATE, address }),
        },
      ];
      for (const c of referencedHookCases) {
        it(`keeps ${c.name} that is a member`, async () => {
          const referenced = await hookTypeStub(c.type);
          const newOwner = randomAddress();
          const { hook, initialHookAddress } = await createHook(
            aggregationOf(referenced, pausableMember(signerAddress)),
          );
          const hooksBefore = await hooksOf(initialHookAddress);
          const pausable = memberOfType(
            await membersOf(initialHookAddress),
            HookType.PAUSABLE,
          );

          const txs = await hook.update(
            aggregationOf(c.asMember(referenced), pausableMember(newOwner)),
          );
          expect(txs).to.have.length(1);
          expect(txs[0].to).to.equal(pausable);
          await sendTxs(txs);

          expect(hook.serialize().deployedHook).to.equal(initialHookAddress);
          expect(await hooksOf(initialHookAddress)).to.deep.equal(hooksBefore);
        });

        it(`redeploys the aggregation when ${c.name} is not a member`, async () => {
          const member = await hookTypeStub(c.type);
          const other = await hookTypeStub(c.type);
          const { hook, initialHookAddress } = await createHook(
            aggregationOf(member, pausableMember(signerAddress)),
          );

          await expectTxsAndUpdate(
            hook,
            aggregationOf(c.asMember(other), pausableMember(signerAddress)),
            0,
          );

          const deployedHook = hook.serialize().deployedHook;
          expect(deployedHook).to.not.equal(initialHookAddress);
          const hooks = await hooksOf(deployedHook);
          expect(hooks.some((address) => eqAddress(address, other))).to.be.true;
          expect(hooks.some((address) => eqAddress(address, member))).to.be
            .false;
        });
      }

      it('keeps an unknown hook given with the address of a member', async () => {
        const custom = randomAddress();
        const newOwner = randomAddress();
        const { hook, initialHookAddress } = await createHook(
          aggregationOf(custom, pausableMember(signerAddress)),
        );
        const hooksBefore = await hooksOf(initialHookAddress);

        const txs = await hook.update(
          aggregationOf(
            { type: HookType.UNKNOWN, address: custom },
            pausableMember(newOwner),
          ),
        );
        expect(txs).to.have.length(1);
        await sendTxs(txs);

        expect(hook.serialize().deployedHook).to.equal(initialHookAddress);
        expect(await hooksOf(initialHookAddress)).to.deep.equal(hooksBefore);
      });

      it('does not keep an unknown hook given with the address of a hook that is not a member', async () => {
        const { hook } = await createHook(
          aggregationOf(randomAddress(), pausableMember(signerAddress)),
        );

        // an unknown hook cannot be deployed
        await expect(
          hook.update(
            aggregationOf(
              { type: HookType.UNKNOWN, address: randomAddress() },
              pausableMember(randomAddress()),
            ),
          ),
        ).to.be.rejectedWith('Unsupported hook config');
      });

      it('does not keep an unknown hook given without an address', async () => {
        const { hook } = await createHook(
          aggregationOf(randomAddress(), pausableMember(signerAddress)),
        );

        // an unknown hook that has no address cannot be told apart from the deployed one
        await expect(
          hook.update(
            aggregationOf(
              { type: HookType.UNKNOWN },
              pausableMember(randomAddress()),
            ),
          ),
        ).to.be.rejectedWith('Unsupported hook config');
      });

      it('does not rewrite the members that the target gives as an address, so that it can be used again', async () => {
        const { initialHookAddress: referenced } = await createHook(
          pausableMember(signerAddress),
        );
        const { hook } = await createHook(
          aggregationOf(referenced, rateLimitedMember(signerAddress)),
        );
        const target = aggregationOf(
          referenced,
          rateLimitedMember(randomAddress()),
        );

        const first = await hook.update(target);
        expect(first).to.have.length(1);
        expect(target.hooks[0]).to.equal(referenced);
        await sendTxs(first);

        // the referenced hook is changed by someone else
        await (
          await PausableHook__factory.connect(referenced, signer).pause()
        ).wait();

        const second = await freshModule(hook, target).update(target);
        expect(second).to.have.length(0);
        expect(
          await PausableHook__factory.connect(
            referenced,
            multiProvider.getProvider(chain),
          ).paused(),
        ).to.be.true;
      });

      function routingOf(
        domains: Record<string, HookConfig>,
      ): DomainRoutingHookConfig {
        return { owner: signerAddress, type: HookType.ROUTING, domains };
      }

      async function routedHook(
        routing: Address,
        domain: string,
      ): Promise<Address> {
        return DomainRoutingHook__factory.connect(
          routing,
          multiProvider.getProvider(chain),
        ).hooks(multiProvider.getDomainId(domain));
      }

      it('redeploys the aggregation when a routing member loses a destination', async () => {
        const { hook, initialHookAddress } = await createHook(
          aggregationOf(
            routingOf({
              [TestChainName.test1]: { type: HookType.MERKLE_TREE },
              [TestChainName.test2]: { type: HookType.MAILBOX_DEFAULT },
            }),
            pausableMember(signerAddress),
          ),
        );

        await expectTxsAndUpdate(
          hook,
          aggregationOf(
            routingOf({
              [TestChainName.test1]: { type: HookType.MERKLE_TREE },
            }),
            pausableMember(randomAddress()),
          ),
          0,
        );

        const deployedHook = hook.serialize().deployedHook;
        expect(deployedHook).to.not.equal(initialHookAddress);
        const routing = memberOfType(
          await membersOf(deployedHook),
          HookType.ROUTING,
        );
        expect(await routedHook(routing, TestChainName.test2)).to.equal(
          hre.ethers.constants.AddressZero,
        );
      });

      it('updates a routing member in place when a destination is added or replaced', async () => {
        const { hook, initialHookAddress } = await createHook(
          aggregationOf(
            routingOf({
              [TestChainName.test1]: { type: HookType.MERKLE_TREE },
            }),
            pausableMember(signerAddress),
          ),
        );
        const membersBefore = await membersOf(initialHookAddress);
        const routing = memberOfType(membersBefore, HookType.ROUTING);
        const replacedBefore = await routedHook(routing, TestChainName.test1);

        // the hooks of the routing member, and the owner of the pausable member
        const txs = await hook.update(
          aggregationOf(
            routingOf({
              [TestChainName.test1]: { type: HookType.MAILBOX_DEFAULT },
              [TestChainName.test2]: { type: HookType.MERKLE_TREE },
            }),
            pausableMember(randomAddress()),
          ),
        );
        expect(txs).to.have.length(2);
        await sendTxs(txs);

        expect(hook.serialize().deployedHook).to.equal(initialHookAddress);
        expect(await membersOf(initialHookAddress)).to.deep.equal(
          membersBefore,
        );
        expect(await routedHook(routing, TestChainName.test1)).to.not.equal(
          replacedBefore,
        );
        expect(await routedHook(routing, TestChainName.test2)).to.not.equal(
          hre.ethers.constants.AddressZero,
        );
      });

      it('redeploys the aggregation when the oracle key of an IGP member changes', async () => {
        const config = await createDeployerOwnedIgpHookConfig();
        const { hook, initialHookAddress } = await createHook(
          aggregationOf({ type: HookType.MERKLE_TREE }, deepCopy(config)),
        );
        const oracleKey = randomAddress();
        const changed = deepCopy(config);
        changed.oracleKey = oracleKey;

        await expectTxsAndUpdate(
          hook,
          aggregationOf({ type: HookType.MERKLE_TREE }, changed),
          0,
        );

        const deployedHook = hook.serialize().deployedHook;
        expect(deployedHook).to.not.equal(initialHookAddress);
        const igp = InterchainGasPaymaster__factory.connect(
          memberOfType(
            await membersOf(deployedHook),
            HookType.INTERCHAIN_GAS_PAYMASTER,
          ),
          multiProvider.getProvider(chain),
        );
        const { gasOracle } = await igp.destinationGasConfigs(
          multiProvider.getDomainId(TestChainName.test1),
        );
        const oracle = StorageGasOracle__factory.connect(
          gasOracle,
          multiProvider.getProvider(chain),
        );
        expect(eqAddress(await oracle.owner(), oracleKey)).to.be.true;
      });

      it('redeploys the aggregation when a nested aggregation is given the address of a hook that is not one of its members', async () => {
        const { initialHookAddress: member } = await createHook(
          pausableMember(signerAddress),
        );
        // the same settings as the member
        const { initialHookAddress: other } = await createHook(
          pausableMember(signerAddress),
        );
        const { initialHookAddress: nested } = await createHook(
          aggregationOf(member, { type: HookType.MAILBOX_DEFAULT }),
        );
        const { hook, initialHookAddress } = await createHook(
          aggregationOf(nested, pausableMember(signerAddress)),
        );

        await expectTxsAndUpdate(
          hook,
          aggregationOf(
            aggregationOf(other, { type: HookType.MAILBOX_DEFAULT }),
            pausableMember(randomAddress()),
          ),
          0,
        );

        expect(hook.serialize().deployedHook).to.not.equal(initialHookAddress);
      });

      it('keeps a nested aggregation that is given the address of one of its members', async () => {
        const { initialHookAddress: member } = await createHook(
          pausableMember(signerAddress),
        );
        const { initialHookAddress: nested } = await createHook(
          aggregationOf(member, { type: HookType.MAILBOX_DEFAULT }),
        );
        const { hook, initialHookAddress } = await createHook(
          aggregationOf(nested, pausableMember(signerAddress)),
        );
        const membersBefore = await membersOf(initialHookAddress);

        const txs = await hook.update(
          aggregationOf(
            aggregationOf(member, { type: HookType.MAILBOX_DEFAULT }),
            pausableMember(randomAddress()),
          ),
        );
        expect(txs).to.have.length(1);
        expect(txs[0].to).to.equal(
          memberOfType(membersBefore, HookType.PAUSABLE),
        );
        await sendTxs(txs);

        expect(hook.serialize().deployedHook).to.equal(initialHookAddress);
        expect(await hooksOf(nested)).to.deep.equal(
          await hooksOf(
            memberOfType(
              await membersOf(initialHookAddress),
              HookType.AGGREGATION,
            ),
          ),
        );
      });

      it('redeploys the aggregation when the update resolves the address of a hybrid hook and ISM', async () => {
        const target = aggregationOf(
          pausableMember(signerAddress),
          rateLimitedMember(randomAddress()),
        );
        const { hook, initialHookAddress } = await createHook(
          aggregationOf(
            pausableMember(signerAddress),
            rateLimitedMember(signerAddress),
          ),
        );

        const txs = await hook.update(target, [randomAddress()]);

        expect(txs).to.have.length(0);
        expect(hook.serialize().deployedHook).to.not.equal(initialHookAddress);
      });

      it('updates the members in place when there is no address of a hybrid hook and ISM', async () => {
        const { hook, initialHookAddress } = await createHook(
          aggregationOf(
            pausableMember(signerAddress),
            rateLimitedMember(signerAddress),
          ),
        );

        const txs = await hook.update(
          aggregationOf(
            pausableMember(signerAddress),
            rateLimitedMember(randomAddress()),
          ),
          [],
        );

        expect(txs).to.have.length(1);
        expect(hook.serialize().deployedHook).to.equal(initialHookAddress);
      });

      describe('nested aggregation hooks', async () => {
        function nestedOf(...hooks: HookConfig[]): AggregationHookConfig {
          return aggregationOf(aggregationOf(...hooks), {
            type: HookType.MAILBOX_DEFAULT,
          });
        }

        it('updates a member of a nested aggregation in place', async () => {
          const pausableOwner = randomAddress();
          const newOwner = randomAddress();
          const { hook, initialHookAddress } = await createHook(
            nestedOf(
              pausableMember(pausableOwner),
              rateLimitedMember(signerAddress),
            ),
          );
          const outerMembers = await membersOf(initialHookAddress);
          const nested = memberOfType(outerMembers, HookType.AGGREGATION);
          const nestedMembers = await membersOf(nested);

          const txs = await hook.update(
            nestedOf(
              pausableMember(pausableOwner),
              rateLimitedMember(newOwner),
            ),
          );
          expect(txs).to.have.length(1);
          expect(txs[0].to).to.equal(
            memberOfType(nestedMembers, HookType.RATE_LIMITED),
          );
          await sendTxs(txs);

          expect(hook.serialize().deployedHook).to.equal(initialHookAddress);
          expect(await membersOf(initialHookAddress)).to.deep.equal(
            outerMembers,
          );
          expect(await membersOf(nested)).to.deep.equal(nestedMembers);
        });

        it('redeploys the outer aggregation when a member of the nested one changes its type', async () => {
          const pausableOwner = randomAddress();
          const { hook, initialHookAddress } = await createHook(
            nestedOf(
              pausableMember(pausableOwner),
              rateLimitedMember(signerAddress),
            ),
          );
          const fromBlock = await multiProvider
            .getProvider(chain)
            .getBlockNumber();

          await expectTxsAndUpdate(
            hook,
            nestedOf(pausableMember(pausableOwner), {
              type: HookType.MERKLE_TREE,
            }),
            0,
          );

          expect(hook.serialize().deployedHook).to.not.equal(
            initialHookAddress,
          );
          // a pausable, a merkle tree and a default hook
          expect(await contractCreationsSince(fromBlock)).to.equal(3);
        });

        it('keeps a nested aggregation that does not change when another member is updated', async () => {
          const newOwner = randomAddress();
          const nestedConfig = aggregationOf(
            pausableMember(randomAddress()),
            pausableMember(randomAddress()),
          );
          // members of the same type cannot be told apart, so the nested
          // aggregation can only be kept as a whole
          const config = aggregationOf(
            nestedConfig,
            rateLimitedMember(signerAddress),
          );
          const { hook, initialHookAddress } = await createHook(config);
          const outerHooks = await hooksOf(initialHookAddress);
          const nested = memberOfType(
            await membersOf(initialHookAddress),
            HookType.AGGREGATION,
          );
          const nestedHooks = await hooksOf(nested);
          // members of the same type are compared in the order of their addresses
          const deployedNested = await new EvmHookReader(
            multiProvider,
            chain,
          ).deriveHookConfig(nested);

          const txs = await hook.update(
            aggregationOf(deployedNested, rateLimitedMember(newOwner)),
          );
          expect(txs).to.have.length(1);
          await sendTxs(txs);

          expect(hook.serialize().deployedHook).to.equal(initialHookAddress);
          expect(await hooksOf(initialHookAddress)).to.deep.equal(outerHooks);
          expect(await hooksOf(nested)).to.deep.equal(nestedHooks);
        });

        it('redeploys the outer aggregation when a member of a nested aggregation that does not change is bound to another mailbox', async () => {
          const bound = await new MerkleTreeHook__factory(signer).deploy(
            otherMailbox,
          );
          const { hook, initialHookAddress } = await createHook(
            aggregationOf(
              aggregationOf(bound.address, pausableMember(signerAddress)),
              rateLimitedMember(signerAddress),
            ),
          );

          await expectTxsAndUpdate(
            hook,
            aggregationOf(
              aggregationOf(
                { type: HookType.MERKLE_TREE },
                pausableMember(signerAddress),
              ),
              rateLimitedMember(randomAddress()),
            ),
            0,
          );

          expect(hook.serialize().deployedHook).to.not.equal(
            initialHookAddress,
          );
        });

        for (const c of boundHookCases) {
          it(`keeps an unchanged nested aggregation with a ${c.name} member that is given as an address and bound to another mailbox`, async () => {
            const bound = await c.deploy(otherMailbox);
            const { initialHookAddress: nested } = await createHook(
              aggregationOf(bound, pausableMember(signerAddress)),
            );
            const { hook, initialHookAddress } = await createHook(
              aggregationOf(nested, pausableMember(signerAddress)),
            );
            const membersBefore = await membersOf(initialHookAddress);
            const nestedHooks = await hooksOf(nested);

            // only the owner of the sibling changes
            const txs = await hook.update(
              aggregationOf(
                aggregationOf(bound, pausableMember(signerAddress)),
                pausableMember(randomAddress()),
              ),
            );
            expect(txs).to.have.length(1);
            expect(txs[0].to).to.equal(
              memberOfType(membersBefore, HookType.PAUSABLE),
            );
            await sendTxs(txs);

            expect(hook.serialize().deployedHook).to.equal(initialHookAddress);
            expect(await membersOf(initialHookAddress)).to.deep.equal(
              membersBefore,
            );
            expect(await hooksOf(nested)).to.deep.equal(nestedHooks);
          });
        }

        it('keeps an unchanged aggregation of an aggregation of a nested aggregation with a merkle tree member that is given as an address and bound to another mailbox', async () => {
          const bound = await new MerkleTreeHook__factory(signer).deploy(
            otherMailbox,
          );
          const { initialHookAddress: inner } = await createHook(
            aggregationOf(bound.address, pausableMember(signerAddress)),
          );
          const { initialHookAddress: mid } = await createHook(
            aggregationOf(inner, { type: HookType.MAILBOX_DEFAULT }),
          );
          const { hook, initialHookAddress } = await createHook(
            aggregationOf(mid, pausableMember(signerAddress)),
          );
          const membersBefore = await membersOf(initialHookAddress);
          const midHooks = await hooksOf(mid);
          const innerHooks = await hooksOf(inner);

          // only the owner of the sibling changes
          const txs = await hook.update(
            aggregationOf(
              aggregationOf(
                aggregationOf(bound.address, pausableMember(signerAddress)),
                { type: HookType.MAILBOX_DEFAULT },
              ),
              pausableMember(randomAddress()),
            ),
          );
          expect(txs).to.have.length(1);
          expect(txs[0].to).to.equal(
            memberOfType(membersBefore, HookType.PAUSABLE),
          );
          await sendTxs(txs);

          expect(hook.serialize().deployedHook).to.equal(initialHookAddress);
          expect(await membersOf(initialHookAddress)).to.deep.equal(
            membersBefore,
          );
          expect(await hooksOf(mid)).to.deep.equal(midHooks);
          expect(await hooksOf(inner)).to.deep.equal(innerHooks);
        });
      });
    });
  });
});
