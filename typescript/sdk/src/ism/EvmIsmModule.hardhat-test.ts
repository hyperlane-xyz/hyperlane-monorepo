/* eslint-disable no-console */
import { expect } from 'chai';
import { Signer } from 'ethers';
import hre from 'hardhat';

import { FallbackDomainRoutingHook__factory } from '@hyperlane-xyz/core';
import {
  Address,
  actualDeepEquals,
  eqAddress,
  normalizeConfig,
} from '@hyperlane-xyz/utils';

import { TestChainName, testChains } from '../consts/testChains.js';
import { HyperlaneAddresses, HyperlaneContracts } from '../contracts/types.js';
import { TestCoreDeployer } from '../core/TestCoreDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEthersV5Transaction } from '../providers/ProviderType.js';
import { randomAddress, randomInt } from '../test/testUtils.js';

import { EvmIsmModule } from './EvmIsmModule.js';
import { HyperlaneIsmFactory } from './HyperlaneIsmFactory.js';
import {
  AggregationIsmConfig,
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

function randomModuleType(): ModuleType {
  const choices = [
    ModuleType.AGGREGATION,
    ModuleType.MERKLE_ROOT_MULTISIG,
    ModuleType.ROUTING,
    ModuleType.NULL,
  ];
  return choices[randomInt(choices.length)];
}

const randomIsmConfig = (depth = 0, maxDepth = 2): IsmConfig => {
  const moduleType =
    depth == maxDepth ? ModuleType.MERKLE_ROOT_MULTISIG : randomModuleType();
  if (moduleType === ModuleType.MERKLE_ROOT_MULTISIG) {
    const n = randomInt(5, 1);
    return randomMultisigIsmConfig(randomInt(n, 1), n);
  } else if (moduleType === ModuleType.ROUTING) {
    const config: RoutingIsmConfig = {
      type: IsmType.ROUTING,
      owner: randomAddress(),
      domains: Object.fromEntries(
        testChains.map((c) => [c, randomIsmConfig(depth + 1)]),
      ),
    };
    return config;
  } else if (moduleType === ModuleType.AGGREGATION) {
    const n = randomInt(5, 1);
    const modules = new Array<number>(n)
      .fill(0)
      .map(() => randomIsmConfig(depth + 1));
    const config: AggregationIsmConfig = {
      type: IsmType.AGGREGATION,
      threshold: randomInt(n, 1),
      modules,
    };
    return config;
  } else if (moduleType === ModuleType.NULL) {
    const config: TrustedRelayerIsmConfig = {
      type: IsmType.TRUSTED_RELAYER,
      relayer: randomAddress(),
    };
    return config;
  } else {
    throw new Error(`Unsupported ISM type: ${moduleType}`);
  }
};

describe('EvmIsmModule', async () => {
  let multiProvider: MultiProvider;
  let ismFactoryDeployer: HyperlaneProxyFactoryDeployer;
  let exampleRoutingConfig: RoutingIsmConfig;
  let mailboxAddress: Address;
  let newMailboxAddress: Address;
  let fundingAccount: Signer;

  const chain = TestChainName.test4;
  let factoryAddresses: HyperlaneAddresses<ProxyFactoryFactories>;
  let factoryContracts: HyperlaneContracts<ProxyFactoryFactories>;

  beforeEach(async () => {
    const [signer, funder] = await hre.ethers.getSigners();
    fundingAccount = funder;
    multiProvider = MultiProvider.createTestMultiProvider({ signer });

    ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
    const contractsMap = await ismFactoryDeployer.deploy(
      multiProvider.mapKnownChains(() => ({})),
    );

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

    // new mailbox
    newMailboxAddress = (
      await new TestCoreDeployer(multiProvider, legacyIsmFactory).deployApp()
    ).getContracts(chain).mailbox.address;

    // example routing config
    exampleRoutingConfig = {
      type: IsmType.ROUTING,
      owner: await multiProvider.getSignerAddress(chain),
      domains: Object.fromEntries(
        testChains
          .filter((c) => c !== TestChainName.test4)
          .map((c) => [c, randomMultisigIsmConfig(3, 5)]),
      ),
    };
  });

  // Wrapper for creating an ISM module
  // include option for mailbox address override
  async function createIsmModule({
    config,
    mailbox = mailboxAddress,
  }: {
    config: IsmConfig;
    mailbox?: Address;
  }): Promise<EvmIsmModule> {
    return EvmIsmModule.create({
      chain,
      config,
      deployer: ismFactoryDeployer,
      factories: factoryAddresses,
      mailbox,
      multiProvider,
    });
  }

  // Wrapper for checking whether ISM module matches a given config
  async function ismModuleMatchesConfig({
    ism,
    config,
  }: {
    ism: EvmIsmModule;
    config: IsmConfig;
  }): Promise<boolean> {
    const derivedConfig = await ism.read();
    const matches = actualDeepEquals(
      normalizeConfig(derivedConfig),
      normalizeConfig(config),
    );
    if (!matches) {
      console.error('Derived config:', derivedConfig);
      console.error('Expected config:', config);
    }
    return matches;
  }

  // Wrapper for create a new multiprovider with an impersonated account
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

  async function logAndSendTransactions(txs: AnnotatedEthersV5Transaction[]) {
    for (const tx of txs) {
      if (tx.annotation) {
        console.log(tx.annotation);
      }
      await multiProvider.sendTransaction(chain, tx.transaction);
    }
  }

  describe('create', async () => {
    it('deploys a simple ism', async () => {
      const config = randomMultisigIsmConfig(3, 5);

      const ism = await createIsmModule({ config });
      expect(await ismModuleMatchesConfig({ ism, config })).to.be.true;
    });

    it('deploys a trusted relayer ism', async () => {
      const relayer = randomAddress();
      const config: TrustedRelayerIsmConfig = {
        type: IsmType.TRUSTED_RELAYER,
        relayer,
      };

      const ism = await createIsmModule({ config });
      expect(await ismModuleMatchesConfig({ ism, config })).to.be.true;
    });

    for (const type of [IsmType.ROUTING, IsmType.FALLBACK_ROUTING]) {
      it(`deploys ${type} routingIsm with correct routes`, async () => {
        exampleRoutingConfig.type = type as
          | IsmType.ROUTING
          | IsmType.FALLBACK_ROUTING;

        const config = exampleRoutingConfig;
        const ism = await createIsmModule({ config });
        expect(await ismModuleMatchesConfig({ ism, config })).to.be.true;
      });
    }

    for (let i = 0; i < 16; i++) {
      it(`deploys a random ism config #${i}`, async () => {
        const config = randomIsmConfig();
        const ism = await createIsmModule({ config });
        expect(await ismModuleMatchesConfig({ ism, config })).to.be.true;
      });
    }
  });

  describe('update', async () => {
    for (const type of [IsmType.ROUTING, IsmType.FALLBACK_ROUTING]) {
      //     it(`should skip deployment with warning if no chain metadata configured ${type}`, async () => {
      //       exampleRoutingConfig.type = type as
      //         | IsmType.ROUTING
      //         | IsmType.FALLBACK_ROUTING;
      //       exampleRoutingConfig.domains[TestChainName.test4] = {
      //         type: IsmType.MESSAGE_ID_MULTISIG,
      //         threshold: 1,
      //         validators: [randomAddress()],
      //       };
      //       // create a new ISM
      //       const ism = await createIsmModule({ config: exampleRoutingConfig });
      //       const matches = await ismModuleMatchesConfig({
      //         ism,
      //         config: exampleRoutingConfig,
      //         configured: false,
      //       });
      //       expect(matches).to.be.true;
      //       // add config for a domain the multiprovider doesn't have
      //       exampleRoutingConfig.domains['test5'] = {
      //         type: IsmType.MESSAGE_ID_MULTISIG,
      //         threshold: 1,
      //         validators: [randomAddress()],
      //       };
      //       // txs required to add test5 domain
      //       const updateTxs = await ism.update(exampleRoutingConfig);
      //       for (const tx of updateTxs) {
      //         if (tx.annotation) {
      //           console.error(tx.annotation);
      //         }
      //       }
      //       // adding test5 domain is no-op, so no txs should be returned
      //       expect(updateTxs.length).to.equal(0);
      //     });
      //     it(`update route in an existing ${type}`, async () => {
      //       exampleRoutingConfig.type = type as
      //         | IsmType.ROUTING
      //         | IsmType.FALLBACK_ROUTING;
      //       // create a new ISM
      //       const ism = await createIsmModule({ config: exampleRoutingConfig });
      //       const matches = await ismModuleMatchesConfig({
      //         ism,
      //         config: exampleRoutingConfig,
      //         configured: false,
      //       });
      //       expect(matches).to.be.true;
      //       // initial ISM address
      //       const initialIsmAddress = ism.serialize().deployedIsm;
      //       // changing the type of a domain should enroll the domain
      //       (
      //         exampleRoutingConfig.domains[TestChainName.test2] as MultisigIsmConfig
      //       ).type = IsmType.MESSAGE_ID_MULTISIG;
      //       // txs required to apply + enroll test2 domain
      //       const enrollTest2MultisigTxs = await ism.update(exampleRoutingConfig);
      //       expect(enrollTest2MultisigTxs.length).to.equal(1);
      //       // enroll the domain
      //       await logAndSendTransactions(enrollTest2MultisigTxs);
      //       // check that the ISM address is the same
      //       expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
      //         .true;
      //       // expect that the ISM matches the config
      //       const matchesAfter = await ismModuleMatchesConfig({
      //         ism,
      //         config: exampleRoutingConfig,
      //         configured: true,
      //       });
      //       expect(matchesAfter).to.be.true;
      //     });
      //     it(`deletes route in an existing ${type}`, async () => {
      //       exampleRoutingConfig.type = type as
      //         | IsmType.ROUTING
      //         | IsmType.FALLBACK_ROUTING;
      //       // create a new ISM
      //       const ism = await createIsmModule({ config: exampleRoutingConfig });
      //       const matches = await ismModuleMatchesConfig({
      //         ism,
      //         config: exampleRoutingConfig,
      //         configured: false,
      //       });
      //       expect(matches).to.be.true;
      //       // initial ISM address
      //       const initialIsmAddress = ism.serialize().deployedIsm;
      //       // deleting the domain should unenroll the domain
      //       delete exampleRoutingConfig.domains[TestChainName.test3];
      //       const deleteTest3Txs = await ism.update(exampleRoutingConfig);
      //       // apply the delete txs
      //       await logAndSendTransactions(deleteTest3Txs);
      //       // expect the ISM address to be the same
      //       expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
      //         .true;
      //       // expect that the ISM matches the config
      //       const matchesAfter = await ismModuleMatchesConfig({
      //         ism,
      //         config: exampleRoutingConfig,
      //         configured: true,
      //       });
      //       expect(matchesAfter).to.be.true;
      //     });
      //     it(`deletes route in an existing ${type} even if not in multiprovider`, async () => {
      //       exampleRoutingConfig.type = type as
      //         | IsmType.ROUTING
      //         | IsmType.FALLBACK_ROUTING;
      //       // create a new ISM
      //       const ism = await createIsmModule({ config: exampleRoutingConfig });
      //       const matches = await ismModuleMatchesConfig({
      //         ism,
      //         config: exampleRoutingConfig,
      //         configured: false,
      //       });
      //       expect(matches).to.be.true;
      //       // keep track of the domains before deleting
      //       const numDomainsBefore = Object.keys(
      //         ((await ism.read()) as RoutingIsmConfig).domains,
      //       ).length;
      //       // deleting the domain and removing from multiprovider should unenroll the domain
      //       delete exampleRoutingConfig.domains[TestChainName.test3];
      //       multiProvider = multiProvider.intersect(
      //         // remove test3 from multiprovider
      //         testChains.filter((c) => c !== TestChainName.test3),
      //       ).result;
      //       // apply the delete txs
      //       const deleteTest3Txs = await ism.update(exampleRoutingConfig);
      //       await logAndSendTransactions(deleteTest3Txs);
      //       // domains should have decreased by 1
      //       const numDomainsAfter = Object.keys(
      //         ((await ism.read()) as RoutingIsmConfig).domains,
      //       ).length;
      //       console.log(numDomainsBefore, numDomainsAfter);
      //       expect(numDomainsBefore - 1).to.equal(numDomainsAfter);
      //       // expect that the ISM matches the config
      //       const matchesAfter = await ismModuleMatchesConfig({
      //         ism,
      //         config: exampleRoutingConfig,
      //         configured: true,
      //       });
      //       expect(matchesAfter).to.be.true;
      //     });
      //     it(`updates owner in an existing ${type}`, async () => {
      //       exampleRoutingConfig.type = type as
      //         | IsmType.ROUTING
      //         | IsmType.FALLBACK_ROUTING;
      //       // create a new ISM
      //       const ism = await createIsmModule({ config: exampleRoutingConfig });
      //       const matches = await ismModuleMatchesConfig({
      //         ism,
      //         config: exampleRoutingConfig,
      //         configured: false,
      //       });
      //       expect(matches).to.be.true;
      //       // initial ISM address
      //       const initialIsmAddress = ism.serialize().deployedIsm;
      //       // change the config owner
      //       exampleRoutingConfig.owner = randomAddress();
      //       // apply the owner change txs
      //       const updateOwnerTxs = await ism.update(exampleRoutingConfig);
      //       await logAndSendTransactions(updateOwnerTxs);
      //       // expect the ISM address to be the same
      //       expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
      //         .true;
      //       // expect that the ISM matches the config
      //       const matchesAfter = await ismModuleMatchesConfig({
      //         ism,
      //         config: exampleRoutingConfig,
      //         configured: true,
      //       });
      //       expect(matchesAfter).to.be.true;
      //     });
      //     it(`no changes to an existing ${type} means no redeployment or updates`, async () => {
      //       exampleRoutingConfig.type = type as
      //         | IsmType.ROUTING
      //         | IsmType.FALLBACK_ROUTING;
      //       // create a new ISM
      //       const ism = await createIsmModule({ config: exampleRoutingConfig });
      //       const matches = await ismModuleMatchesConfig({
      //         ism,
      //         config: exampleRoutingConfig,
      //         configured: false,
      //       });
      //       expect(matches).to.be.true;
      //       // initial ISM address
      //       const initialIsmAddress = ism.serialize().deployedIsm;
      //       // no changes to the config
      //       const updateTxs = await ism.update(exampleRoutingConfig);
      //       expect(updateTxs.length).to.equal(0);
      //       // expect the ISM address to be the same
      //       expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
      //         .true;
      //       // expect that the ISM matches the config
      //       const matchesAfter = await ismModuleMatchesConfig({
      //         ism,
      //         config: exampleRoutingConfig,
      //         configured: true,
      //       });
      //       expect(matchesAfter).to.be.true;
      //     });
      it(`update owner in an existing ${type} not owned by deployer`, async () => {
        exampleRoutingConfig.type = type as
          | IsmType.ROUTING
          | IsmType.FALLBACK_ROUTING;

        // ISM owner is not the deployer
        exampleRoutingConfig.owner = randomAddress();
        const originalOwner = exampleRoutingConfig.owner;

        // create a new ISM
        const ism = await createIsmModule({ config: exampleRoutingConfig });
        const matches = await ismModuleMatchesConfig({
          ism,
          config: exampleRoutingConfig,
        });
        expect(matches).to.be.true;

        // initial ISM address
        const initialIsmAddress = ism.serialize().deployedIsm;

        // apply the owner change to the new ISM
        const applyTxs = await ism.update(exampleRoutingConfig);
        await logAndSendTransactions(applyTxs);

        // update the config owner
        exampleRoutingConfig.owner = randomAddress();
        const updateTxs = await ism.update(exampleRoutingConfig);

        // apply the owner change txs whilst impersonating the original owner
        multiProvider = await impersonateAccount(originalOwner);
        await logAndSendTransactions(updateTxs);

        // expect the ISM address to be unchanged
        expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
          .true;

        // expect that the ISM matches the config
        const matchesAfter = await ismModuleMatchesConfig({
          ism,
          config: exampleRoutingConfig,
        });
        expect(matchesAfter).to.be.true;
      });
      //     it(`update validators in an existing ${type}`, async () => {
      //       exampleRoutingConfig.type = type as
      //         | IsmType.ROUTING
      //         | IsmType.FALLBACK_ROUTING;
      //       // create a new ISM
      //       const ism = await createIsmModule({ config: exampleRoutingConfig });
      //       const matches = await ismModuleMatchesConfig({
      //         ism,
      //         config: exampleRoutingConfig,
      //         configured: false,
      //       });
      //       expect(matches).to.be.true;
      //       // initial ISM address
      //       const initialIsmAddress = ism.serialize().deployedIsm;
      //       // update the validators for a domain
      //       (
      //         exampleRoutingConfig.domains[TestChainName.test2] as MultisigIsmConfig
      //       ).validators = [randomAddress(), randomAddress()];
      //       // txs required to update validators
      //       const updateValidatorsTxs = await ism.update(exampleRoutingConfig);
      //       expect(updateValidatorsTxs.length).to.be.greaterThan(0);
      //       // apply the update validators txs
      //       await logAndSendTransactions(updateValidatorsTxs);
      //       // expect the ISM address to be the same
      //       expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
      //         .true;
      //       // expect that the ISM matches the config
      //       const matchesAfter = await ismModuleMatchesConfig({
      //         ism,
      //         config: exampleRoutingConfig,
      //         configured: true,
      //       });
      //       expect(matchesAfter).to.be.true;
      //     });
      //     it(`update threshold in an existing ${type}`, async () => {
      //       exampleRoutingConfig.type = type as
      //         | IsmType.ROUTING
      //         | IsmType.FALLBACK_ROUTING;
      //       // create a new ISM
      //       const ism = await createIsmModule({ config: exampleRoutingConfig });
      //       const matches = await ismModuleMatchesConfig({
      //         ism,
      //         config: exampleRoutingConfig,
      //         configured: false,
      //       });
      //       expect(matches).to.be.true;
      //       // initial ISM address
      //       const initialIsmAddress = ism.serialize().deployedIsm;
      //       // update the threshold for a domain
      //       (
      //         exampleRoutingConfig.domains[TestChainName.test2] as MultisigIsmConfig
      //       ).threshold = 2;
      //       // txs required to update threshold
      //       const updateThresholdTxs = await ism.update(exampleRoutingConfig);
      //       expect(updateThresholdTxs.length).to.be.greaterThan(0);
      //       // apply the update threshold txs
      //       await logAndSendTransactions(updateThresholdTxs);
      //       // expect the ISM address to be the same
      //       expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
      //         .true;
      //       // expect that the ISM matches the config
      //       const matchesAfter = await ismModuleMatchesConfig({
      //         ism,
      //         config: exampleRoutingConfig,
      //         configured: true,
      //       });
      //       expect(matchesAfter).to.be.true;
      //     });
    }

    it(`redeploy same config if the mailbox address changes for defaultFallbackRoutingIsm`, async () => {
      exampleRoutingConfig.type = IsmType.FALLBACK_ROUTING;

      // create a new ISM
      const ism = await createIsmModule({ config: exampleRoutingConfig });
      const matches = await ismModuleMatchesConfig({
        ism,
        config: exampleRoutingConfig,
      });
      expect(matches).to.be.true;

      // initial ISM address
      const initialIsmAddress = ism.serialize().deployedIsm;

      // point to new mailbox
      ism.setNewMailbox(newMailboxAddress);

      // create and apply the update txs
      const updateTxs = await ism.update(exampleRoutingConfig);
      await logAndSendTransactions(updateTxs);

      // expect the ISM address to be different
      expect(eqAddress(initialIsmAddress, ism.serialize().deployedIsm)).to.be
        .false;

      // expect that the ISM is configured with the new mailbox
      const onchainIsm = FallbackDomainRoutingHook__factory.connect(
        ism.serialize().deployedIsm,
        multiProvider.getSigner(chain),
      );
      const onchainMailbox = await onchainIsm['mailbox()']();
      expect(eqAddress(onchainMailbox, newMailboxAddress)).to.be.true;

      // expect that the ISM matches the config
      const matchesAfter = await ismModuleMatchesConfig({
        ism,
        config: exampleRoutingConfig,
      });
      expect(matchesAfter).to.be.true;
    });
  });
});
