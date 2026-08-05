import assert from 'assert';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Signer } from 'ethers';
import hre from 'hardhat';

import {
  BlacklistIsm__factory,
  RateLimitedIsm__factory,
  StaticAggregationIsm__factory,
} from '@hyperlane-xyz/core';

import { Address, eqAddress } from '@hyperlane-xyz/utils';

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
  BlacklistIsmConfig,
  DomainRoutingIsmConfig,
  IsmConfig,
  IsmType,
  ModuleType,
  MultisigIsmConfig,
  RateLimitedIsmConfig,
  RoutingIsmConfig,
  TrustedRelayerIsmConfig,
} from './types.js';

chai.use(chaiAsPromised);

const randomBytes32 = () =>
  hre.ethers.utils.hexlify(hre.ethers.utils.randomBytes(32));

// Blacklist ISMs are only valid in a mandatory (exhaustive-aggregation)
// position, so build a standalone one to prove the composition walk rejects it.
const BLACKLIST_COMPOSITION_ERROR = 'must be a member of an aggregation';

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

  // ism module and config for testing
  let testIsm: EvmIsmModule;
  let testConfig: IsmConfig;

  // expect that the ISM matches the config after all tests
  afterEach(async () => {
    const derivedConfiig = await testIsm.read();

    const normalizedDerivedConfig = normalizeConfig(derivedConfiig);
    const normalizedConfig = normalizeConfig(testConfig);

    // recipient is a deploy-time constructor arg not returned by read()
    if (normalizedConfig.type === IsmType.RATE_LIMITED) {
      delete normalizedConfig.recipient;
    }

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
        duration: 86400n,
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

    it('deploys a blacklist submodule under an exhaustive aggregation and transfers ownership to non-deployer', async () => {
      const owner = randomAddress();
      const blacklistedIds = [randomBytes32(), randomBytes32()];
      const blacklistSubmodule: BlacklistIsmConfig = {
        type: IsmType.BLACKLIST,
        owner,
        blacklistedIds,
      };

      // threshold === modules.length: the blacklist sits in a mandatory
      // (exhaustive-aggregation) position, so the composition invariant holds
      const config: AggregationIsmConfig = {
        type: IsmType.AGGREGATION,
        modules: [randomMultisigIsmConfig(3, 5), blacklistSubmodule],
        threshold: 2,
      };

      const { ism } = await createIsm(config);

      const provider = multiProvider.getProvider(chain);
      const [moduleAddresses] = await StaticAggregationIsm__factory.connect(
        ism.serialize().deployedIsm,
        provider,
      ).modulesAndThreshold(hre.ethers.constants.AddressZero);

      let blacklistFound = false;
      for (const moduleAddress of moduleAddresses) {
        const blacklistIsm = BlacklistIsm__factory.connect(
          moduleAddress,
          provider,
        );
        if ((await blacklistIsm.moduleType()) === ModuleType.NULL) {
          expect((await blacklistIsm.owner()).toLowerCase()).to.equal(
            owner.toLowerCase(),
          );
          for (const id of blacklistedIds) {
            expect(await blacklistIsm.blacklistedIds(id)).to.be.true;
          }
          blacklistFound = true;
        }
      }
      expect(blacklistFound).to.be.true;
    });

    it('rejects create of a standalone blacklist ism', async () => {
      // seed a valid deployed ISM so the afterEach invariant reads a real config
      await createIsm(randomMultisigIsmConfig(3, 5));

      const config: BlacklistIsmConfig = {
        type: IsmType.BLACKLIST,
        owner: randomAddress(),
        blacklistedIds: [randomBytes32()],
      };

      await expect(
        EvmIsmModule.create({
          chain,
          config,
          proxyFactoryFactories: factoryAddresses,
          mailbox: mailboxAddress,
          multiProvider,
        }),
      ).to.be.rejectedWith(BLACKLIST_COMPOSITION_ERROR);
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

      const { ism, initialIsmAddress } = await createIsm(
        config as AggregationIsmConfig,
      );

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

    it('transfers ownership in-place on ownership change', async () => {
      const recipient = randomAddress();
      const signerAddress = await multiProvider.getSignerAddress(chain);
      const rateLimitedConfig: RateLimitedIsmConfig = {
        type: IsmType.RATE_LIMITED,
        maxCapacity: '86400',
        duration: 86400n,
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

    it('redeploys a new ISM on duration change (immutable)', async () => {
      const recipient = randomAddress();
      const signerAddress = await multiProvider.getSignerAddress(chain);
      const rateLimitedConfig: RateLimitedIsmConfig = {
        type: IsmType.RATE_LIMITED,
        maxCapacity: '86400',
        duration: 86400n,
        recipient,
        owner: signerAddress,
      };

      const { ism, initialIsmAddress } = await createIsm(rateLimitedConfig);

      // duration is immutable on-chain; changing it must redeploy a fresh ISM.
      // keep maxCapacity a multiple of the new duration (schema constraint).
      rateLimitedConfig.duration = 3600n;
      rateLimitedConfig.maxCapacity = '3600';

      // update() redeploys internally and emits no txs
      await expectTxsAndUpdate(ism, rateLimitedConfig, 0);

      // different contract address — redeployed
      expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
        .false;

      const rateLimitedIsm = RateLimitedIsm__factory.connect(
        ism.serialize().deployedIsm,
        multiProvider.getProvider(chain),
      );
      expect((await rateLimitedIsm.DURATION()).toString()).to.equal('3600');
    });

    it('redeploys the aggregation when a blacklisted ID is dropped under an exhaustive aggregation (append-only)', async () => {
      const signerAddress = await multiProvider.getSignerAddress(chain);
      const idToKeep = randomBytes32();
      const idToDrop = randomBytes32();
      const blacklistSubmodule: BlacklistIsmConfig = {
        type: IsmType.BLACKLIST,
        owner: signerAddress,
        blacklistedIds: [idToKeep, idToDrop],
      };

      // threshold === modules.length: mandatory (exhaustive-aggregation) position
      const config: AggregationIsmConfig = {
        type: IsmType.AGGREGATION,
        modules: [randomMultisigIsmConfig(3, 5), blacklistSubmodule],
        threshold: 2,
      };
      const { ism, initialIsmAddress } = await createIsm(config);

      // entries are append-only on-chain; dropping one must redeploy a fresh ISM,
      // which changes the submodule address and forces the container to redeploy
      blacklistSubmodule.blacklistedIds = [idToKeep];

      // update() redeploys internally and emits no txs
      await expectTxsAndUpdate(ism, config, 0);

      // different aggregation address — redeployed
      expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
        .false;

      const provider = multiProvider.getProvider(chain);
      const [moduleAddresses] = await StaticAggregationIsm__factory.connect(
        ism.serialize().deployedIsm,
        provider,
      ).modulesAndThreshold(hre.ethers.constants.AddressZero);

      let blacklistFound = false;
      for (const moduleAddress of moduleAddresses) {
        const blacklistIsm = BlacklistIsm__factory.connect(
          moduleAddress,
          provider,
        );
        if ((await blacklistIsm.moduleType()) === ModuleType.NULL) {
          expect(await blacklistIsm.blacklistedIds(idToKeep)).to.be.true;
          expect(await blacklistIsm.blacklistedIds(idToDrop)).to.be.false;
          blacklistFound = true;
        }
      }
      expect(blacklistFound).to.be.true;
    });

    it('rejects update to a standalone blacklist ism', async () => {
      const { ism } = await createIsm(randomMultisigIsmConfig(3, 5));

      const standaloneBlacklist: BlacklistIsmConfig = {
        type: IsmType.BLACKLIST,
        owner: await multiProvider.getSignerAddress(chain),
        blacklistedIds: [randomBytes32()],
      };

      await expect(ism.update(standaloneBlacklist)).to.be.rejectedWith(
        BLACKLIST_COMPOSITION_ERROR,
      );
    });

    it('updates a blacklist submodule in-place under an exhaustive aggregation', async () => {
      const signerAddress = await multiProvider.getSignerAddress(chain);
      const existingIds = [randomBytes32()];
      const blacklistSubmodule: BlacklistIsmConfig = {
        type: IsmType.BLACKLIST,
        owner: signerAddress,
        blacklistedIds: [...existingIds],
      };

      // threshold === modules.length: the blacklist sits in a mandatory
      // (exhaustive-aggregation) position, so the composition invariant holds
      const config: AggregationIsmConfig = {
        type: IsmType.AGGREGATION,
        modules: [randomMultisigIsmConfig(3, 5), blacklistSubmodule],
        threshold: 2,
      };

      const { ism, initialIsmAddress } = await createIsm(config);

      const newId = randomBytes32();
      // mutate in-place so testConfig (same reference) stays in sync for afterEach
      blacklistSubmodule.blacklistedIds = [...existingIds, newId];

      // 1 tx blacklisting only the new ID on the submodule; aggregation stays put
      await expectTxsAndUpdate(ism, config, 1);

      // same aggregation address — container updated in place, no redeploy
      expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
        .true;

      const provider = multiProvider.getProvider(chain);
      const [moduleAddresses] = await StaticAggregationIsm__factory.connect(
        ism.serialize().deployedIsm,
        provider,
      ).modulesAndThreshold(hre.ethers.constants.AddressZero);

      let blacklistFound = false;
      for (const moduleAddress of moduleAddresses) {
        const blacklistIsm = BlacklistIsm__factory.connect(
          moduleAddress,
          provider,
        );
        if ((await blacklistIsm.moduleType()) === ModuleType.NULL) {
          expect(await blacklistIsm.blacklistedIds(newId)).to.be.true;
          blacklistFound = true;
        }
      }
      expect(blacklistFound).to.be.true;
    });
  });
});
