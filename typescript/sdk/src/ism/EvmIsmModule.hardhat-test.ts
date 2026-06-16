import assert from 'assert';
import { expect } from 'chai';
import { Signer } from 'ethers';
import hre from 'hardhat';

import {
  RateLimitedIsm__factory,
  StaticAggregationIsm__factory,
} from '@hyperlane-xyz/core';

import { Address, deepEquals, eqAddress } from '@hyperlane-xyz/utils';

import { TestChainName, testChains } from '../consts/testChains.js';
import { HyperlaneAddresses, HyperlaneContracts } from '../contracts/types.js';
import { TestCoreDeployer } from '../core/TestCoreDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import {
  randomAddress,
  randomIsmConfig,
  randomMultisigIsmConfig,
} from '../test/testUtils.js';
import { normalizeConfig } from '../utils/ism.js';

import { EvmIsmModule } from './EvmIsmModule.js';
import { HyperlaneIsmFactory } from './HyperlaneIsmFactory.js';
import {
  AggregationIsmConfig,
  AmountRoutingIsmConfig,
  DomainRoutingIsmConfig,
  IsmConfig,
  IsmType,
  MultisigIsmConfig,
  RateLimitedIsmConfig,
  RoutingIsmConfig,
  TrustedRelayerIsmConfig,
} from './types.js';

describe('EvmIsmModule', async () => {
  let multiProvider: MultiProvider;
  let exampleRoutingConfig: DomainRoutingIsmConfig;
  let mailboxAddress: Address;
  let fundingAccount: Signer;

  const chain = TestChainName.test4;
  let factoryAddresses: HyperlaneAddresses<ProxyFactoryFactories>;
  let factoryContracts: HyperlaneContracts<ProxyFactoryFactories>;

  before(async () => {
    const [signer, funder] = await hre.ethers.getSigners();
    fundingAccount = funder;
    multiProvider = MultiProvider.createTestMultiProvider({ signer });

    const contractsMap = await new HyperlaneProxyFactoryDeployer(
      multiProvider,
    ).deploy(multiProvider.mapKnownChains(() => ({})));

    // get addresses of factories for the chain
    factoryContracts = contractsMap[chain];
    factoryAddresses = Object.keys(factoryContracts).reduce(
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

    // mailbox
    mailboxAddress = (
      await new TestCoreDeployer(multiProvider, legacyIsmFactory).deployApp()
    ).getContracts(chain).mailbox.address;
  });

  beforeEach(async () => {
    // Reset the MultiProvider for each test
    const [signer] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });

    // example routing config
    exampleRoutingConfig = {
      type: IsmType.ROUTING,
      owner: (await multiProvider.getSignerAddress(chain)).toLowerCase(),
      domains: Object.fromEntries(
        testChains
          .filter((c) => c !== TestChainName.test4)
          .map((c) => [c, randomMultisigIsmConfig(3, 5)]),
      ),
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
    ism: EvmIsmModule,
    config: IsmConfig,
    n: number,
  ) {
    const txs = await ism.update(config);
    expect(txs.length).to.equal(n);

    for (const tx of txs) {
      await multiProvider.sendTransaction(chain, tx);
    }
  }

  async function readIsmAt(
    deployedIsm: Address,
    config: Exclude<IsmConfig, string>,
  ): Promise<IsmConfig> {
    return new EvmIsmModule(multiProvider, {
      chain,
      config,
      addresses: {
        ...factoryAddresses,
        mailbox: mailboxAddress,
        deployedIsm,
      },
    }).read();
  }

  async function aggregationModuleAddresses(
    deployedIsm: Address,
  ): Promise<Address[]> {
    const aggregationIsm = StaticAggregationIsm__factory.connect(
      deployedIsm,
      multiProvider.getProvider(chain),
    );
    const [moduleAddresses] = await aggregationIsm.modulesAndThreshold(
      hre.ethers.constants.AddressZero,
    );
    return moduleAddresses;
  }

  async function findAggregationModuleAddress(
    deployedIsm: Address,
    type: IsmType,
    config: Exclude<IsmConfig, string>,
  ): Promise<Address> {
    for (const moduleAddress of await aggregationModuleAddresses(deployedIsm)) {
      const moduleConfig = await readIsmAt(moduleAddress, config);
      if (typeof moduleConfig !== 'string' && moduleConfig.type === type) {
        return moduleAddress;
      }
    }
    throw new Error(`No ${type} module found`);
  }

  function removeRateLimitedRecipients(config: IsmConfig): IsmConfig {
    const normalizedConfig = normalizeConfig(config);
    if (typeof normalizedConfig === 'string') return normalizedConfig;

    if (normalizedConfig.type === IsmType.RATE_LIMITED) {
      const { recipient: _recipient, ...configWithoutRecipient } =
        normalizedConfig;
      return configWithoutRecipient;
    }

    if (normalizedConfig.type === IsmType.AGGREGATION) {
      return {
        ...normalizedConfig,
        modules: normalizedConfig.modules.map(removeRateLimitedRecipients),
      };
    }

    if (normalizedConfig.type === IsmType.AMOUNT_ROUTING) {
      return {
        ...normalizedConfig,
        lowerIsm: removeRateLimitedRecipients(normalizedConfig.lowerIsm),
        upperIsm: removeRateLimitedRecipients(normalizedConfig.upperIsm),
      };
    }

    if (
      normalizedConfig.type === IsmType.ROUTING ||
      normalizedConfig.type === IsmType.FALLBACK_ROUTING ||
      normalizedConfig.type === IsmType.INCREMENTAL_ROUTING
    ) {
      return {
        ...normalizedConfig,
        domains: Object.fromEntries(
          Object.keys(normalizedConfig.domains).map((origin) => {
            const ismConfig = normalizedConfig.domains[origin];
            assert(ismConfig);
            return [origin, removeRateLimitedRecipients(ismConfig)];
          }),
        ),
      };
    }

    return normalizedConfig;
  }

  // ism module and config for testing
  let testIsm: EvmIsmModule;
  let testConfig: IsmConfig;

  // expect that the ISM matches the config after all tests
  afterEach(async () => {
    const derivedConfiig = await testIsm.read();

    const normalizedDerivedConfig = removeRateLimitedRecipients(derivedConfiig);
    const normalizedConfig = removeRateLimitedRecipients(testConfig);

    assert.deepStrictEqual(normalizedDerivedConfig, normalizedConfig);
  });

  // create a new ISM and verify that it matches the config
  async function createIsm(
    config: IsmConfig,
  ): Promise<{ ism: EvmIsmModule; initialIsmAddress: Address }> {
    const ism = await EvmIsmModule.create({
      chain,
      config,
      proxyFactoryFactories: factoryAddresses,
      mailbox: mailboxAddress,
      multiProvider,
    });
    testIsm = ism;
    testConfig = config;
    return { ism, initialIsmAddress: ism.serialize().deployedIsm };
  }

  describe('create', async () => {
    it('deploys a simple ism', async () => {
      const config = randomMultisigIsmConfig(3, 5);
      await createIsm(config);
    });

    it('deploys a trusted relayer ism', async () => {
      const relayer = randomAddress();
      const config: TrustedRelayerIsmConfig = {
        type: IsmType.TRUSTED_RELAYER,
        relayer,
      };
      await createIsm(config);
    });

    for (const type of [IsmType.ROUTING, IsmType.FALLBACK_ROUTING]) {
      it(`deploys ${type} routingIsm with correct routes`, async () => {
        exampleRoutingConfig.type = type;
        await createIsm(exampleRoutingConfig);
      });
    }

    it(`deploys ${IsmType.AMOUNT_ROUTING}`, async () => {
      await createIsm({
        type: IsmType.AMOUNT_ROUTING,
        lowerIsm: randomMultisigIsmConfig(3, 5),
        upperIsm: randomMultisigIsmConfig(3, 5),
        threshold: 2,
      });
    });

    it('deploys a rate limited ism and transfers ownership to non-deployer', async () => {
      const recipient = randomAddress();
      const owner = randomAddress();
      const config: RateLimitedIsmConfig = {
        type: IsmType.RATE_LIMITED,
        maxCapacity: '86400',
        recipient,
        owner,
      };
      const { ism } = await createIsm(config);

      const rateLimitedIsm = RateLimitedIsm__factory.connect(
        ism.serialize().deployedIsm,
        multiProvider.getProvider(chain),
      );
      expect((await rateLimitedIsm.owner()).toLowerCase()).to.equal(
        owner.toLowerCase(),
      );
    });

    for (let i = 0; i < 16; i++) {
      it(`deploys a random ism config #${i}`, async () => {
        const config = randomIsmConfig();
        await createIsm(config);
      });
    }

    it('deploys a rate limited ism via randomIsmConfig', async () => {
      const config = randomIsmConfig(
        undefined,
        undefined,
        IsmType.RATE_LIMITED,
      );
      await createIsm(config);
    });
  });

  describe('update', async () => {
    for (const type of [IsmType.ROUTING, IsmType.FALLBACK_ROUTING]) {
      beforeEach(() => {
        exampleRoutingConfig.type = type;
      });

      it(`should skip deployment with warning if no chain metadata configured ${type}`, async () => {
        // create a new ISM
        const { ism } = await createIsm(exampleRoutingConfig);

        // create an updated config with a domain the multiprovider doesn't have
        const updatedRoutingConfig: IsmConfig = {
          ...exampleRoutingConfig,
          domains: {
            ...exampleRoutingConfig.domains,
            test5: randomMultisigIsmConfig(3, 5),
          },
        };

        // expect 0 txs, as adding test5 domain is no-op
        await expectTxsAndUpdate(ism, updatedRoutingConfig, 0);
      });

      it(`update route in an existing ${type}`, async () => {
        // create a new ISM
        const { ism, initialIsmAddress } =
          await createIsm(exampleRoutingConfig);

        // changing the type of a domain should enroll the domain
        (
          exampleRoutingConfig.domains[TestChainName.test2] as MultisigIsmConfig
        ).type = IsmType.MESSAGE_ID_MULTISIG;

        // expect 1 tx to enroll test2 domain
        await expectTxsAndUpdate(ism, exampleRoutingConfig, 1);

        // check that the ISM address is the same
        expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
          .true;
      });

      it(`deletes route in an existing ${type}`, async () => {
        // create a new ISM
        const { ism, initialIsmAddress } =
          await createIsm(exampleRoutingConfig);

        // deleting the domain should unenroll the domain
        delete exampleRoutingConfig.domains[TestChainName.test3];

        // expect 1 tx to unenroll test3 domain
        await expectTxsAndUpdate(ism, exampleRoutingConfig, 1);

        // expect the ISM address to be the same
        expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
          .true;
      });

      it(`deletes route in an existing ${type} even if not in multiprovider`, async () => {
        // create a new ISM
        const { ism } = await createIsm(exampleRoutingConfig);

        // keep track of the domains before deleting
        const numDomainsBefore = Object.keys(
          ((await ism.read()) as DomainRoutingIsmConfig).domains,
        ).length;

        // deleting the domain and removing from multiprovider should unenroll the domain
        delete exampleRoutingConfig.domains[TestChainName.test3];
        multiProvider = multiProvider.intersect(
          // remove test3 from multiprovider
          testChains.filter((c) => c !== TestChainName.test3),
        ).result;

        // expect 1 tx to unenroll test3 domain
        await expectTxsAndUpdate(ism, exampleRoutingConfig, 1);

        // domains should have decreased by 1
        const numDomainsAfter = Object.keys(
          ((await ism.read()) as DomainRoutingIsmConfig).domains,
        ).length;
        expect(numDomainsBefore - 1).to.equal(numDomainsAfter);
      });

      it(`updates owner in an existing ${type}`, async () => {
        // create a new ISM
        const { ism, initialIsmAddress } =
          await createIsm(exampleRoutingConfig);

        // change the config owner
        exampleRoutingConfig.owner = randomAddress();

        // expect 1 tx to transfer ownership
        await expectTxsAndUpdate(ism, exampleRoutingConfig, 1);

        // expect the ISM address to be the same
        expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
          .true;
      });

      it(`no changes to an existing ${type} means no redeployment or updates`, async () => {
        // create a new ISM
        const { ism, initialIsmAddress } =
          await createIsm(exampleRoutingConfig);

        // expect 0 updates
        await expectTxsAndUpdate(ism, exampleRoutingConfig, 0);

        // expect the ISM address to be the same
        expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
          .true;
      });

      it(`reordering validators in an existing ${type} should not trigger a redeployment`, async () => {
        // create a new ISM
        const routerConfig = {
          type: IsmType.ROUTING,
          owner: (await multiProvider.getSignerAddress(chain)).toLowerCase(),
          domains: {
            test1: {
              type: IsmType.MERKLE_ROOT_MULTISIG,
              validators: [
                '0x5FbDB2315678afecb367f032d93F642f64180aa3',
                '0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2',
                '0x4B20993Bc481177ec7E8f571ceCaE8A9e22C02db',
              ],
              threshold: 2,
            },
            test2: {
              type: IsmType.MERKLE_ROOT_MULTISIG,
              validators: [
                '0x5FbDB2315678afecb367f032d93F642f64180aa3',
                '0x4B20993Bc481177ec7E8f571ceCaE8A9e22C02db',
                '0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2',
              ],
              threshold: 2,
            },
          },
        };

        const { ism, initialIsmAddress } = await createIsm(
          routerConfig as RoutingIsmConfig,
        );

        const updatedRouterConfig = {
          type: IsmType.ROUTING,
          owner: (await multiProvider.getSignerAddress(chain)).toLowerCase(),
          domains: {
            test1: {
              type: IsmType.MERKLE_ROOT_MULTISIG,
              validators: [
                '0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2',
                '0x4B20993Bc481177ec7E8f571ceCaE8A9e22C02db',
                '0x5FbDB2315678afecb367f032d93F642f64180aa3',
              ],
              threshold: 2,
            },
            test2: {
              type: IsmType.MERKLE_ROOT_MULTISIG,
              validators: [
                '0x4B20993Bc481177ec7E8f571ceCaE8A9e22C02db',
                '0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2',
                '0x5FbDB2315678afecb367f032d93F642f64180aa3',
              ],
              threshold: 2,
            },
          },
        };

        // expect 0 updates
        await expectTxsAndUpdate(
          ism,
          updatedRouterConfig as RoutingIsmConfig,
          0,
        );

        // expect the ISM address to be the same
        expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
          .true;
      });

      it(`update owner in an existing ${type} not owned by deployer`, async () => {
        // ISM owner is not the deployer
        exampleRoutingConfig.owner = randomAddress();
        const originalOwner = exampleRoutingConfig.owner;

        // create a new ISM
        const { ism, initialIsmAddress } =
          await createIsm(exampleRoutingConfig);

        // update the config owner and impersonate the original owner
        exampleRoutingConfig.owner = randomAddress();
        multiProvider = await impersonateAccount(originalOwner);

        // expect 1 tx to transfer ownership
        await expectTxsAndUpdate(ism, exampleRoutingConfig, 1);

        // expect the ISM address to be unchanged
        expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
          .true;
      });

      it(`update validators in an existing ${type}`, async () => {
        // create a new ISM
        const { ism, initialIsmAddress } =
          await createIsm(exampleRoutingConfig);

        // update the validators for a domain
        exampleRoutingConfig.domains[TestChainName.test2] = {
          type: IsmType.MERKLE_ROOT_MULTISIG,
          validators: [randomAddress(), randomAddress()],
          threshold: 2,
        };

        // expect 1 tx to update validator set for test2 domain
        await expectTxsAndUpdate(ism, exampleRoutingConfig, 1);

        // expect the ISM address to be the same
        expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
          .true;
      });

      it(`update threshold in an existing ${type}`, async () => {
        // create a new ISM
        const { ism, initialIsmAddress } =
          await createIsm(exampleRoutingConfig);

        // update the threshold for a domain
        (
          exampleRoutingConfig.domains[TestChainName.test2] as MultisigIsmConfig
        ).threshold = 2;

        // expect 1 tx to update threshold for test2 domain
        await expectTxsAndUpdate(ism, exampleRoutingConfig, 1);

        // expect the ISM address to be the same
        expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
          .true;
      });

      it(`update threshold in an existing ${type} with Module creating using constructor`, async () => {
        // create an initial ISM
        const { initialIsmAddress } = await createIsm(exampleRoutingConfig);

        // update the threshold for a domain
        (
          exampleRoutingConfig.domains[TestChainName.test2] as MultisigIsmConfig
        ).threshold = 2;

        // create a new IsmModule using it's constructor. Set it's deployedIsm address to the initialIsmAddr
        const ism = new EvmIsmModule(multiProvider, {
          chain,
          config: exampleRoutingConfig,
          addresses: {
            ...factoryAddresses,
            mailbox: mailboxAddress,
            deployedIsm: initialIsmAddress,
          },
        });

        // expect 1 tx to update threshold for test2 domain
        await expectTxsAndUpdate(ism, exampleRoutingConfig, 1);

        // expect the ISM address to be the same
        expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
          .true;
      });
    }

    it(`reordering modules in an existing staticAggregationIsm should not trigger a redeployment`, async () => {
      // create a new ISM
      const config: AggregationIsmConfig = {
        type: IsmType.AGGREGATION,
        modules: [
          {
            type: IsmType.MERKLE_ROOT_MULTISIG,
            validators: [
              '0x5FbDB2315678afecb367f032d93F642f64180aa3',
              '0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2',
              '0x4B20993Bc481177ec7E8f571ceCaE8A9e22C02db',
            ],
            threshold: 2,
          },
          {
            type: IsmType.ROUTING,
            owner: (await multiProvider.getSignerAddress(chain)).toLowerCase(),
            domains: {
              test1: {
                type: IsmType.MERKLE_ROOT_MULTISIG,
                validators: [
                  '0x5FbDB2315678afecb367f032d93F642f64180aa3',
                  '0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2',
                  '0x4B20993Bc481177ec7E8f571ceCaE8A9e22C02db',
                ],
                threshold: 2,
              },
              test2: {
                type: IsmType.MERKLE_ROOT_MULTISIG,
                validators: [
                  '0x5FbDB2315678afecb367f032d93F642f64180aa3',
                  '0x4B20993Bc481177ec7E8f571ceCaE8A9e22C02db',
                  '0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2',
                ],
                threshold: 2,
              },
            },
          },
        ],
        threshold: 2,
      };

      const { ism, initialIsmAddress } = await createIsm(config);

      const updatedConfig: AggregationIsmConfig = {
        type: IsmType.AGGREGATION,
        modules: [
          {
            type: IsmType.ROUTING,
            owner: (await multiProvider.getSignerAddress(chain)).toLowerCase(),
            domains: {
              test2: {
                type: IsmType.MERKLE_ROOT_MULTISIG,
                validators: [
                  '0x5FbDB2315678afecb367f032d93F642f64180aa3',
                  '0x4B20993Bc481177ec7E8f571ceCaE8A9e22C02db',
                  '0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2',
                ],
                threshold: 2,
              },
              test1: {
                type: IsmType.MERKLE_ROOT_MULTISIG,
                validators: [
                  '0x5FbDB2315678afecb367f032d93F642f64180aa3',
                  '0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2',
                  '0x4B20993Bc481177ec7E8f571ceCaE8A9e22C02db',
                ],
                threshold: 2,
              },
            },
          },
          {
            type: IsmType.MERKLE_ROOT_MULTISIG,
            validators: [
              '0x5FbDB2315678afecb367f032d93F642f64180aa3',
              '0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2',
              '0x4B20993Bc481177ec7E8f571ceCaE8A9e22C02db',
            ],
            threshold: 2,
          },
        ],
        threshold: 2,
      };

      // expect 0 updates
      await expectTxsAndUpdate(ism, updatedConfig, 0);

      // expect the ISM address to be the same
      expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
        .true;
    });

    it('updates uniquely typed aggregation sub-modules in-place', async () => {
      const owner = (await multiProvider.getSignerAddress(chain)).toLowerCase();
      const multisigConfig = randomMultisigIsmConfig(3, 5);
      const routingConfig: DomainRoutingIsmConfig = {
        type: IsmType.ROUTING,
        owner,
        domains: {
          test1: randomMultisigIsmConfig(3, 5),
        },
      };
      const config: AggregationIsmConfig = {
        type: IsmType.AGGREGATION,
        modules: [multisigConfig, routingConfig],
        threshold: 2,
      };

      const { ism, initialIsmAddress } = await createIsm(config);

      const updatedConfig: AggregationIsmConfig = {
        ...config,
        modules: [
          multisigConfig,
          {
            ...routingConfig,
            domains: {
              ...routingConfig.domains,
              test2: randomMultisigIsmConfig(3, 5),
            },
          },
        ],
      };
      testConfig = updatedConfig;

      await expectTxsAndUpdate(ism, updatedConfig, 1);

      expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
        .true;
    });

    it('redeploys aggregation when duplicate sub-module types make matching ambiguous', async () => {
      const owner = (await multiProvider.getSignerAddress(chain)).toLowerCase();
      const config: AggregationIsmConfig = {
        type: IsmType.AGGREGATION,
        modules: [
          {
            type: IsmType.ROUTING,
            owner,
            domains: {
              test1: randomMultisigIsmConfig(3, 5),
            },
          },
          {
            type: IsmType.ROUTING,
            owner,
            domains: {
              test2: randomMultisigIsmConfig(3, 5),
            },
          },
        ],
        threshold: 2,
      };

      const { ism, initialIsmAddress } = await createIsm(config);
      const currentConfig = (await ism.read()) as AggregationIsmConfig;
      const originalModuleAddresses =
        await aggregationModuleAddresses(initialIsmAddress);
      const [firstModule, secondModule] =
        currentConfig.modules as DomainRoutingIsmConfig[];
      assert(firstModule.type === IsmType.ROUTING);
      assert(secondModule.type === IsmType.ROUTING);
      const originalFirstConfig = normalizeConfig(
        await readIsmAt(originalModuleAddresses[0], firstModule),
      );
      const originalSecondConfig = normalizeConfig(
        await readIsmAt(originalModuleAddresses[1], secondModule),
      );

      const updatedSecondModule: DomainRoutingIsmConfig = {
        ...secondModule,
        domains: {
          ...secondModule.domains,
          test3: randomMultisigIsmConfig(3, 5),
        },
      };
      const updatedConfig: AggregationIsmConfig = {
        type: IsmType.AGGREGATION,
        modules: [updatedSecondModule, firstModule],
        threshold: currentConfig.threshold,
      };

      const txs = await ism.update(updatedConfig);
      expect(txs.length).to.equal(0);
      expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
        .false;
      expect(
        originalModuleAddresses.some((address) =>
          eqAddress(address, ism.serialize().deployedIsm),
        ),
      ).to.be.false;
      expect(
        deepEquals(
          normalizeConfig(
            await readIsmAt(originalModuleAddresses[0], firstModule),
          ),
          originalFirstConfig,
        ),
      ).to.be.true;
      expect(
        deepEquals(
          normalizeConfig(
            await readIsmAt(originalModuleAddresses[1], secondModule),
          ),
          originalSecondConfig,
        ),
      ).to.be.true;

      // Duplicate aggregation modules have no canonical config order after
      // factory address sorting, so keep the generic afterEach check aligned to
      // the deployed order after asserting semantic config equivalence above.
      const actualConfig = normalizeConfig(
        await ism.read(),
      ) as AggregationIsmConfig;
      const actualModules = actualConfig.modules as DomainRoutingIsmConfig[];
      const firstDomains = normalizeConfig(firstModule.domains);
      const updatedSecondDomains = normalizeConfig(updatedSecondModule.domains);
      expect(actualModules).to.have.length(2);
      expect(
        actualModules.some((module) =>
          deepEquals(normalizeConfig(module.domains), firstDomains),
        ),
      ).to.be.true;
      expect(
        actualModules.some((module) =>
          deepEquals(normalizeConfig(module.domains), updatedSecondDomains),
        ),
      ).to.be.true;
      testConfig = actualConfig;
    });

    it('updates nested container sub-modules in-place after recursive preflight', async () => {
      const owner = (await multiProvider.getSignerAddress(chain)).toLowerCase();
      const lowerIsm: DomainRoutingIsmConfig = {
        type: IsmType.ROUTING,
        owner,
        domains: {
          test1: randomMultisigIsmConfig(3, 5),
        },
      };
      const amountRoutingConfig: AmountRoutingIsmConfig = {
        type: IsmType.AMOUNT_ROUTING,
        lowerIsm,
        upperIsm: randomMultisigIsmConfig(3, 5),
        threshold: 2,
      };
      const config: AggregationIsmConfig = {
        type: IsmType.AGGREGATION,
        modules: [amountRoutingConfig, randomMultisigIsmConfig(3, 5)],
        threshold: 2,
      };

      const { ism, initialIsmAddress } = await createIsm(config);
      const initialAmountRoutingAddress = await findAggregationModuleAddress(
        initialIsmAddress,
        IsmType.AMOUNT_ROUTING,
        amountRoutingConfig,
      );

      const updatedConfig: AggregationIsmConfig = {
        ...config,
        modules: [
          {
            ...amountRoutingConfig,
            lowerIsm: {
              ...lowerIsm,
              domains: {
                ...lowerIsm.domains,
                test2: randomMultisigIsmConfig(3, 5),
              },
            },
          },
          config.modules[1],
        ],
      };
      testConfig = updatedConfig;

      await expectTxsAndUpdate(ism, updatedConfig, 1);

      expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
        .true;
      expect(
        eqAddress(
          initialAmountRoutingAddress,
          await findAggregationModuleAddress(
            ism.serialize().deployedIsm,
            IsmType.AMOUNT_ROUTING,
            amountRoutingConfig,
          ),
        ),
      ).to.be.true;
    });

    it('falls back before mutating earlier container sub-modules when preflight fails', async () => {
      const owner = (await multiProvider.getSignerAddress(chain)).toLowerCase();
      const routingConfig: DomainRoutingIsmConfig = {
        type: IsmType.ROUTING,
        owner,
        domains: {
          test1: randomMultisigIsmConfig(3, 5),
        },
      };
      const multisigConfig = randomMultisigIsmConfig(3, 5);
      const config: AggregationIsmConfig = {
        type: IsmType.AGGREGATION,
        modules: [routingConfig, multisigConfig],
        threshold: 2,
      };

      const { ism, initialIsmAddress } = await createIsm(config);
      const originalRoutingAddress = await findAggregationModuleAddress(
        initialIsmAddress,
        IsmType.ROUTING,
        routingConfig,
      );
      const originalRoutingConfig = normalizeConfig(
        await readIsmAt(originalRoutingAddress, routingConfig),
      );

      const updatedConfig: AggregationIsmConfig = {
        ...config,
        modules: [
          {
            ...routingConfig,
            domains: {
              ...routingConfig.domains,
              test2: randomMultisigIsmConfig(3, 5),
            },
          },
          {
            ...multisigConfig,
            threshold: multisigConfig.threshold + 1,
          },
        ],
      };
      testConfig = updatedConfig;

      const txs = await ism.update(updatedConfig);
      expect(txs.length).to.equal(0);
      expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
        .false;
      expect(
        deepEquals(
          normalizeConfig(
            await readIsmAt(originalRoutingAddress, routingConfig),
          ),
          originalRoutingConfig,
        ),
      ).to.be.true;
    });

    it(`updates ${IsmType.AMOUNT_ROUTING} sub-modules by fixed slot`, async () => {
      const owner = (await multiProvider.getSignerAddress(chain)).toLowerCase();
      const lowerIsm: DomainRoutingIsmConfig = {
        type: IsmType.ROUTING,
        owner,
        domains: {
          test1: randomMultisigIsmConfig(3, 5),
        },
      };
      const config: AmountRoutingIsmConfig = {
        type: IsmType.AMOUNT_ROUTING,
        lowerIsm,
        upperIsm: randomMultisigIsmConfig(3, 5),
        threshold: 2,
      };

      const { ism, initialIsmAddress } = await createIsm(config);

      const updatedConfig: AmountRoutingIsmConfig = {
        ...config,
        lowerIsm: {
          ...lowerIsm,
          domains: {
            ...lowerIsm.domains,
            test2: randomMultisigIsmConfig(3, 5),
          },
        },
      };
      testConfig = updatedConfig;

      await expectTxsAndUpdate(ism, updatedConfig, 1);

      expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
        .true;
    });

    it(`updates nested ${IsmType.RATE_LIMITED} sub-modules with unchanged recipients`, async () => {
      const signerAddress = await multiProvider.getSignerAddress(chain);
      const recipient = randomAddress();
      const rateLimitedConfig: RateLimitedIsmConfig = {
        type: IsmType.RATE_LIMITED,
        maxCapacity: '86400',
        recipient,
        owner: signerAddress,
      };
      const config: AggregationIsmConfig = {
        type: IsmType.AGGREGATION,
        modules: [rateLimitedConfig, randomMultisigIsmConfig(3, 5)],
        threshold: 2,
      };

      const { ism, initialIsmAddress } = await createIsm(config);
      const updatedRateLimitedConfig: RateLimitedIsmConfig = {
        ...rateLimitedConfig,
        owner: randomAddress(),
      };
      const updatedConfig: AggregationIsmConfig = {
        ...config,
        modules: [updatedRateLimitedConfig, config.modules[1]],
      };
      testConfig = updatedConfig;

      await expectTxsAndUpdate(ism, updatedConfig, 1);

      expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
        .true;
    });

    it(`redeploys ${IsmType.AMOUNT_ROUTING} when container fields change`, async () => {
      const lowerIsm = randomMultisigIsmConfig(3, 5);
      const upperIsm = randomMultisigIsmConfig(3, 5);
      const config: AmountRoutingIsmConfig = {
        type: IsmType.AMOUNT_ROUTING,
        lowerIsm,
        upperIsm,
        threshold: 2,
      };

      const { ism, initialIsmAddress } = await createIsm(config);
      const updatedConfig: AmountRoutingIsmConfig = {
        ...config,
        threshold: 1,
      };
      testConfig = updatedConfig;

      const txs = await ism.update(updatedConfig);
      expect(txs.length).to.equal(0);
      expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
        .false;
    });

    it('transfers ownership in-place on ownership change', async () => {
      const recipient = randomAddress();
      const signerAddress = await multiProvider.getSignerAddress(chain);
      const rateLimitedConfig: RateLimitedIsmConfig = {
        type: IsmType.RATE_LIMITED,
        maxCapacity: '86400',
        recipient,
        owner: signerAddress,
      };

      const { ism, initialIsmAddress } = await createIsm(rateLimitedConfig);

      const newOwner = randomAddress();
      // mutate in-place so testConfig (same reference) stays in sync for afterEach
      rateLimitedConfig.owner = newOwner;

      // RATE_LIMITED is mutable — update() transfers ownership in-place (1 tx)
      await expectTxsAndUpdate(ism, rateLimitedConfig, 1);

      // same contract address — no redeploy
      expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
        .true;

      const rateLimitedIsm = RateLimitedIsm__factory.connect(
        ism.serialize().deployedIsm,
        multiProvider.getProvider(chain),
      );
      expect((await rateLimitedIsm.owner()).toLowerCase()).to.equal(
        newOwner.toLowerCase(),
      );
    });
  });
});
