import assert from 'assert';
import { expect } from 'chai';
import { Signer } from 'ethers';
import hre from 'hardhat';

import { Address, eqAddress } from '@hyperlane-xyz/utils';

import { TestChainName, testChains } from '../consts/testChains.js';
import { HyperlaneAddresses, HyperlaneContracts } from '../contracts/types.js';
import { TestCoreDeployer } from '../core/TestCoreDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { randomAddress, randomInt } from '../test/testUtils.js';
import { normalizeConfig } from '../utils/ism.js';

import { EvmIsmModule } from './EvmIsmModule.js';
import { HyperlaneIsmFactory } from './HyperlaneIsmFactory.js';
import {
  AggregationIsmConfig,
  DomainRoutingIsmConfig,
  IsmConfig,
  IsmType,
  ModuleType,
  MultisigIsmConfig,
  RoutingIsmConfig,
  TrustedRelayerIsmConfig,
} from './types.js';

const randomMultisigIsmConfig = (m: number, n: number): MultisigIsmConfig => {
  const emptyArray = new Array<number>(n).fill(0);
  const validators = emptyArray.map(() => randomAddress());
  return {
    type: IsmType.MERKLE_ROOT_MULTISIG,
    validators,
    threshold: m,
  };
};

const ModuleTypes = [
  ModuleType.AGGREGATION,
  ModuleType.MERKLE_ROOT_MULTISIG,
  ModuleType.ROUTING,
  ModuleType.NULL,
];

const NonNestedModuleTypes = [ModuleType.MERKLE_ROOT_MULTISIG, ModuleType.NULL];

function randomModuleType(): ModuleType {
  return ModuleTypes[randomInt(ModuleTypes.length)];
}

function randomNonNestedModuleType(): ModuleType {
  return NonNestedModuleTypes[randomInt(NonNestedModuleTypes.length)];
}

const randomIsmConfig = (
  depth = 0,
  maxDepth = 2,
): Exclude<IsmConfig, string> => {
  const moduleType =
    depth === maxDepth ? randomNonNestedModuleType() : randomModuleType();

  switch (moduleType) {
    case ModuleType.MERKLE_ROOT_MULTISIG: {
      const n = randomInt(5, 1);
      return randomMultisigIsmConfig(randomInt(n, 1), n);
    }
    case ModuleType.ROUTING: {
      const config: RoutingIsmConfig = {
        type: IsmType.ROUTING,
        owner: randomAddress(),
        domains: Object.fromEntries(
          testChains.map((c) => [c, randomIsmConfig(depth + 1)]),
        ),
      };
      return config;
    }
    case ModuleType.AGGREGATION: {
      const n = randomInt(2, 1);
      const moduleTypes = new Set();
      const modules = new Array<number>(n).fill(0).map(() => {
        let moduleConfig: Exclude<IsmConfig, string>;
        let moduleType: IsmType;

        // Ensure that we do not add the same module type more than once per level
        do {
          moduleConfig = randomIsmConfig(depth + 1, maxDepth);
          moduleType = moduleConfig.type;
        } while (moduleTypes.has(moduleType));

        moduleTypes.add(moduleType);
        return moduleConfig;
      });
      const config: AggregationIsmConfig = {
        type: IsmType.AGGREGATION,
        threshold: randomInt(n, 1),
        modules,
      };
      return config;
    }
    case ModuleType.NULL: {
      const config: TrustedRelayerIsmConfig = {
        type: IsmType.TRUSTED_RELAYER,
        relayer: randomAddress(),
      };
      return config;
    }
    default:
      throw new Error(`Unsupported ISM type: ${moduleType}`);
  }
};

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
    factoryAddresses = Object.keys(factoryContracts).reduce((acc, key) => {
      acc[key] =
        contractsMap[chain][key as keyof ProxyFactoryFactories].address;
      return acc;
    }, {} as Record<string, Address>) as HyperlaneAddresses<ProxyFactoryFactories>;

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
        exampleRoutingConfig.type = type as
          | IsmType.ROUTING
          | IsmType.FALLBACK_ROUTING;
        await createIsm(exampleRoutingConfig);
      });
    }

    it(`deploys ${IsmType.ICA_ROUTING}`, async () => {
      await createIsm({
        type: IsmType.ICA_ROUTING,
      });
    });

    for (let i = 0; i < 16; i++) {
      it(`deploys a random ism config #${i}`, async () => {
        const config = randomIsmConfig();
        await createIsm(config);
      });
    }
  });

  describe('update', async () => {
    for (const type of [IsmType.ROUTING, IsmType.FALLBACK_ROUTING]) {
      beforeEach(() => {
        exampleRoutingConfig.type = type as
          | IsmType.ROUTING
          | IsmType.FALLBACK_ROUTING;
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
        const { ism, initialIsmAddress } = await createIsm(
          exampleRoutingConfig,
        );

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
        const { ism, initialIsmAddress } = await createIsm(
          exampleRoutingConfig,
        );

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
        const { ism, initialIsmAddress } = await createIsm(
          exampleRoutingConfig,
        );

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
        const { ism, initialIsmAddress } = await createIsm(
          exampleRoutingConfig,
        );

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
        const { ism, initialIsmAddress } = await createIsm(
          exampleRoutingConfig,
        );

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
        const { ism, initialIsmAddress } = await createIsm(
          exampleRoutingConfig,
        );

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
        const { ism, initialIsmAddress } = await createIsm(
          exampleRoutingConfig,
        );

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
        // create a an initial ISM
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
  });
});
