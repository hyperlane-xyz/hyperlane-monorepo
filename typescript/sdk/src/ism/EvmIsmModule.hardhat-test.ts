import assert from 'assert';
import { expect } from 'chai';
import { Signer } from 'ethers';
import hre from 'hardhat';

import {
  DelayedFlowRouterHookIsm__factory,
  HypERC20__factory,
  NetFlowRateLimitedHookIsm__factory,
  RateLimitedIsm__factory,
} from '@hyperlane-xyz/core';

import { Address, addressToBytes32, eqAddress } from '@hyperlane-xyz/utils';

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
  DelayedFlowRouterHookIsmConfig,
  DomainRoutingIsmConfig,
  IsmConfig,
  IsmType,
  MailboxDefaultIsmConfig,
  MultisigIsmConfig,
  NetFlowRateLimitedHookIsmConfig,
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
  // paired TokenRouter required by the warp-route hybrid hook/ISM constructors
  let warpRouterAddress: Address;

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

    warpRouterAddress = (
      await new HypERC20__factory(signer).deploy(18, 1, 1, mailboxAddress)
    ).address;
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

    it('deploys a mailbox default ism', async () => {
      const config: MailboxDefaultIsmConfig = {
        type: IsmType.MAILBOX_DEFAULT,
      };
      await createIsm(config);
    });

    it('deploys a net flow rate limited hook ism and transfers ownership to non-deployer', async () => {
      const owner = randomAddress();
      const config: NetFlowRateLimitedHookIsmConfig = {
        type: IsmType.NET_FLOW_RATE_LIMITED,
        warpRouter: warpRouterAddress,
        thresholdBps: 500,
        duration: 86400n,
        owner,
      };
      const { ism } = await createIsm(config);

      const netFlowIsm = NetFlowRateLimitedHookIsm__factory.connect(
        ism.serialize().deployedIsm,
        multiProvider.getProvider(chain),
      );
      expect((await netFlowIsm.owner()).toLowerCase()).to.equal(
        owner.toLowerCase(),
      );
      expect((await netFlowIsm.warpRouter()).toLowerCase()).to.equal(
        warpRouterAddress.toLowerCase(),
      );
    });

    it('deploys a delayed flow router hook ism, enrolling routers before transferring ownership', async () => {
      // owner is a non-deployer EOA: the deploy only succeeds if the
      // owner-gated enrollment happens BEFORE the ownership transfer
      const owner = randomAddress();
      const remoteRouter = addressToBytes32(randomAddress()).toLowerCase();
      const config: DelayedFlowRouterHookIsmConfig = {
        type: IsmType.DELAYED_FLOW_ROUTER,
        warpRouter: warpRouterAddress,
        thresholdBps: 10000,
        maxDelay: 3600,
        duration: 86400n,
        owner,
        remoteIsms: { [TestChainName.test2]: remoteRouter },
      };
      const { ism } = await createIsm(config);

      const delayedIsm = DelayedFlowRouterHookIsm__factory.connect(
        ism.serialize().deployedIsm,
        multiProvider.getProvider(chain),
      );
      expect(
        await delayedIsm.routers(
          multiProvider.getDomainId(TestChainName.test2),
        ),
      ).to.equal(remoteRouter);
      expect((await delayedIsm.owner()).toLowerCase()).to.equal(
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

    it('no changes to an existing mailbox default ism means no redeployment or updates', async () => {
      const config: MailboxDefaultIsmConfig = {
        type: IsmType.MAILBOX_DEFAULT,
      };
      const { ism, initialIsmAddress } = await createIsm(config);

      await expectTxsAndUpdate(ism, config, 0);

      expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
        .true;
    });

    it('redeploys when changing a mailbox default ism to another type', async () => {
      const { ism, initialIsmAddress } = await createIsm({
        type: IsmType.MAILBOX_DEFAULT,
      });

      const trustedRelayerConfig: TrustedRelayerIsmConfig = {
        type: IsmType.TRUSTED_RELAYER,
        relayer: randomAddress(),
      };
      // keep testConfig in sync for the afterEach read-back assertion
      testConfig = trustedRelayerConfig;
      // update() redeploys internally and emits no txs
      await expectTxsAndUpdate(ism, trustedRelayerConfig, 0);

      expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
        .false;
    });

    it('transfers netFlowRateLimitedHookIsm ownership in-place on owner change', async () => {
      const signerAddress = await multiProvider.getSignerAddress(chain);
      const netFlowConfig: NetFlowRateLimitedHookIsmConfig = {
        type: IsmType.NET_FLOW_RATE_LIMITED,
        warpRouter: warpRouterAddress,
        thresholdBps: 500,
        duration: 86400n,
        owner: signerAddress,
      };

      const { ism, initialIsmAddress } = await createIsm(netFlowConfig);

      const newOwner = randomAddress();
      // mutate in-place so testConfig (same reference) stays in sync for afterEach
      netFlowConfig.owner = newOwner;

      // NET_FLOW_RATE_LIMITED is mutable — update() transfers ownership in-place (1 tx)
      await expectTxsAndUpdate(ism, netFlowConfig, 1);

      // same contract address — no redeploy
      expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
        .true;

      const netFlowIsm = NetFlowRateLimitedHookIsm__factory.connect(
        ism.serialize().deployedIsm,
        multiProvider.getProvider(chain),
      );
      expect((await netFlowIsm.owner()).toLowerCase()).to.equal(
        newOwner.toLowerCase(),
      );
    });

    it('redeploys a new netFlowRateLimitedHookIsm on thresholdBps change (immutable)', async () => {
      const signerAddress = await multiProvider.getSignerAddress(chain);
      const netFlowConfig: NetFlowRateLimitedHookIsmConfig = {
        type: IsmType.NET_FLOW_RATE_LIMITED,
        warpRouter: warpRouterAddress,
        thresholdBps: 500,
        duration: 86400n,
        owner: signerAddress,
      };

      const { ism, initialIsmAddress } = await createIsm(netFlowConfig);

      // thresholdBps is immutable on-chain; changing it must redeploy
      netFlowConfig.thresholdBps = 750;

      // update() redeploys internally and emits no txs
      await expectTxsAndUpdate(ism, netFlowConfig, 0);

      // different contract address — redeployed
      expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
        .false;

      const netFlowIsm = NetFlowRateLimitedHookIsm__factory.connect(
        ism.serialize().deployedIsm,
        multiProvider.getProvider(chain),
      );
      expect((await netFlowIsm.thresholdBps()).toString()).to.equal('750');
    });

    it('updates netFlowRateLimitedHookIsm owner in-place inside an aggregation ism without redeploying the container', async () => {
      // the contract mandates composing NetFlowRateLimitedHookIsm under an
      // authenticating ISM, so aggregation-wrapped is the primary shape
      const signerAddress = await multiProvider.getSignerAddress(chain);
      const netFlowConfig: NetFlowRateLimitedHookIsmConfig = {
        type: IsmType.NET_FLOW_RATE_LIMITED,
        warpRouter: warpRouterAddress,
        thresholdBps: 500,
        duration: 86400n,
        owner: signerAddress,
      };
      const aggregationConfig: AggregationIsmConfig = {
        type: IsmType.AGGREGATION,
        modules: [netFlowConfig, randomMultisigIsmConfig(3, 5)],
        threshold: 2,
      };

      const { ism, initialIsmAddress } = await createIsm(aggregationConfig);

      // mutate in-place so testConfig (same reference) stays in sync for afterEach
      const newOwner = randomAddress();
      netFlowConfig.owner = newOwner;

      // owner is the netFlow's only mutable field: expect a single in-place
      // transferOwnership tx, with the aggregation container untouched
      await expectTxsAndUpdate(ism, aggregationConfig, 1);

      expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
        .true;
    });

    it('no changes to an existing delayedFlowRouterHookIsm means no redeployment or updates', async () => {
      const signerAddress = await multiProvider.getSignerAddress(chain);
      const delayedConfig: DelayedFlowRouterHookIsmConfig = {
        type: IsmType.DELAYED_FLOW_ROUTER,
        warpRouter: warpRouterAddress,
        thresholdBps: 10000,
        maxDelay: 3600,
        duration: 86400n,
        owner: signerAddress,
        remoteIsms: {
          [TestChainName.test2]:
            addressToBytes32(randomAddress()).toLowerCase(),
        },
      };

      const { ism, initialIsmAddress } = await createIsm(delayedConfig);

      await expectTxsAndUpdate(ism, delayedConfig, 0);

      expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
        .true;
    });

    it('does not redeploy a delayedFlowRouterHookIsm when the target omits warpRouter', async () => {
      const signerAddress = await multiProvider.getSignerAddress(chain);
      const delayedConfig: DelayedFlowRouterHookIsmConfig = {
        type: IsmType.DELAYED_FLOW_ROUTER,
        warpRouter: warpRouterAddress,
        thresholdBps: 10000,
        maxDelay: 3600,
        duration: 86400n,
        owner: signerAddress,
        remoteIsms: {},
      };

      const { ism, initialIsmAddress } = await createIsm(delayedConfig);

      // warp-route-context configs omit warpRouter (implicitly the token);
      // the update must treat it as unchanged, not as an immutable-field change
      const targetWithoutWarpRouter: DelayedFlowRouterHookIsmConfig = {
        type: IsmType.DELAYED_FLOW_ROUTER,
        thresholdBps: 10000,
        maxDelay: 3600,
        duration: 86400n,
        owner: signerAddress,
        remoteIsms: {},
      };
      await expectTxsAndUpdate(ism, targetWithoutWarpRouter, 0);

      expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
        .true;
    });

    it('enrolls and unenrolls remote routers on an existing delayedFlowRouterHookIsm', async () => {
      const signerAddress = await multiProvider.getSignerAddress(chain);
      const test2Router = addressToBytes32(randomAddress()).toLowerCase();
      const test3Router = addressToBytes32(randomAddress()).toLowerCase();
      const delayedConfig: DelayedFlowRouterHookIsmConfig = {
        type: IsmType.DELAYED_FLOW_ROUTER,
        warpRouter: warpRouterAddress,
        thresholdBps: 10000,
        maxDelay: 3600,
        duration: 86400n,
        owner: signerAddress,
        remoteIsms: { [TestChainName.test2]: test2Router },
      };

      const { ism, initialIsmAddress } = await createIsm(delayedConfig);

      // replace test2 with test3: 1 enroll tx + 1 unenroll tx
      delayedConfig.remoteIsms = { [TestChainName.test3]: test3Router };
      await expectTxsAndUpdate(ism, delayedConfig, 2);

      expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
        .true;

      const delayedIsm = DelayedFlowRouterHookIsm__factory.connect(
        ism.serialize().deployedIsm,
        multiProvider.getProvider(chain),
      );
      const test3Domain = multiProvider.getDomainId(TestChainName.test3);
      expect(await delayedIsm.routers(test3Domain)).to.equal(test3Router);
      const enrolledDomains = await delayedIsm.domains();
      expect(enrolledDomains.map((domain) => Number(domain))).to.deep.equal([
        test3Domain,
      ]);
    });

    it('transfers delayedFlowRouterHookIsm ownership after enrollment updates', async () => {
      const signerAddress = await multiProvider.getSignerAddress(chain);
      const delayedConfig: DelayedFlowRouterHookIsmConfig = {
        type: IsmType.DELAYED_FLOW_ROUTER,
        warpRouter: warpRouterAddress,
        thresholdBps: 10000,
        maxDelay: 3600,
        duration: 86400n,
        owner: signerAddress,
        remoteIsms: {},
      };

      const { ism, initialIsmAddress } = await createIsm(delayedConfig);

      // enroll a router AND hand over ownership in the same update: the txs
      // only execute successfully if enrollment (owner-gated) precedes the
      // ownership transfer
      const newOwner = randomAddress();
      delayedConfig.remoteIsms = {
        [TestChainName.test2]: addressToBytes32(randomAddress()).toLowerCase(),
      };
      delayedConfig.owner = newOwner;
      await expectTxsAndUpdate(ism, delayedConfig, 2);

      expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
        .true;

      const delayedIsm = DelayedFlowRouterHookIsm__factory.connect(
        ism.serialize().deployedIsm,
        multiProvider.getProvider(chain),
      );
      expect((await delayedIsm.owner()).toLowerCase()).to.equal(
        newOwner.toLowerCase(),
      );
    });

    it('redeploys a new delayedFlowRouterHookIsm on maxDelay change (immutable)', async () => {
      const signerAddress = await multiProvider.getSignerAddress(chain);
      const delayedConfig: DelayedFlowRouterHookIsmConfig = {
        type: IsmType.DELAYED_FLOW_ROUTER,
        warpRouter: warpRouterAddress,
        thresholdBps: 10000,
        maxDelay: 3600,
        duration: 86400n,
        owner: signerAddress,
        remoteIsms: {},
      };

      const { ism, initialIsmAddress } = await createIsm(delayedConfig);

      // maxDelay is immutable on-chain; changing it must redeploy
      delayedConfig.maxDelay = 7200;

      // update() redeploys internally and emits no txs
      await expectTxsAndUpdate(ism, delayedConfig, 0);

      // different contract address — redeployed
      expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
        .false;

      const delayedIsm = DelayedFlowRouterHookIsm__factory.connect(
        ism.serialize().deployedIsm,
        multiProvider.getProvider(chain),
      );
      expect(await delayedIsm.maxDelay()).to.equal(7200);
    });
  });
});
