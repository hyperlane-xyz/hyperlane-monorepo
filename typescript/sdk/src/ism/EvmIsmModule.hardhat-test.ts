/* eslint-disable no-console */
import { expect } from 'chai';
import hre from 'hardhat';

import { Address, stringifyObject } from '@hyperlane-xyz/utils';

import { TestChainName, testChains } from '../consts/testChains.js';
import { HyperlaneAddresses, HyperlaneContracts } from '../contracts/types.js';
import { TestCoreApp } from '../core/TestCoreApp.js';
import { TestCoreDeployer } from '../core/TestCoreDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { MultiProvider } from '../providers/MultiProvider.js';
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
import { moduleMatchesConfig } from './utils.js';

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
    // TODO: update module comparison to support aggregation ISMs that do not have the same order
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
  let coreApp: TestCoreApp;
  let multiProvider: MultiProvider;
  let ismFactoryDeployer: HyperlaneProxyFactoryDeployer;
  let exampleRoutingConfig: RoutingIsmConfig;
  let mailboxAddress: Address;

  const chain = TestChainName.test1;
  let factoryAddresses: HyperlaneAddresses<ProxyFactoryFactories>;
  let factoryContracts: HyperlaneContracts<ProxyFactoryFactories>;

  beforeEach(async () => {
    const [signer] = await hre.ethers.getSigners();
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

    // mailbox
    const ismFactory = new HyperlaneIsmFactory(contractsMap, multiProvider);
    const coreDeployer = new TestCoreDeployer(multiProvider, ismFactory);
    coreApp = await coreDeployer.deployApp();
    mailboxAddress = coreApp.getContracts(chain).mailbox.address;

    // // new mailbox
    // coreDeployer = new TestCoreDeployer(multiProvider, ismFactory);
    // coreApp = await coreDeployer.deployApp();
    // newMailboxAddress = coreApp.getContracts(chain).mailbox.address;

    // example routing config
    exampleRoutingConfig = {
      type: IsmType.ROUTING,
      owner: await multiProvider.getSignerAddress(chain),
      domains: Object.fromEntries(
        testChains
          .filter((c) => c !== TestChainName.test1)
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
  // include option for mailbox address override
  async function ismModuleMatchesConfig({
    ism,
    config,
    mailbox = mailboxAddress,
    configured = true,
  }: {
    ism: EvmIsmModule;
    config: IsmConfig;
    mailbox?: Address;
    configured: boolean;
  }): Promise<boolean> {
    return moduleMatchesConfig(
      chain,
      ism.serialize().deployedIsm,
      config,
      multiProvider,
      factoryContracts,
      mailbox,
      configured,
    );
  }

  describe('create', async () => {
    it('deploys a simple ism', async () => {
      const config = randomMultisigIsmConfig(3, 5);

      const ism = await createIsmModule({ config });
      const matches = await ismModuleMatchesConfig({
        ism,
        config,
        configured: false,
      });
      expect(matches).to.be.true;
    });

    it('deploys a trusted relayer ism', async () => {
      const relayer = randomAddress();
      const config: TrustedRelayerIsmConfig = {
        type: IsmType.TRUSTED_RELAYER,
        relayer,
      };

      const ism = await createIsmModule({ config });
      const matches = await ismModuleMatchesConfig({
        ism,
        config,
        configured: false,
      });
      expect(matches).to.be.true;
    });

    for (const type of [IsmType.ROUTING, IsmType.FALLBACK_ROUTING]) {
      it(`deploys ${type} routingIsm with correct routes`, async () => {
        exampleRoutingConfig.type = type as
          | IsmType.ROUTING
          | IsmType.FALLBACK_ROUTING;

        const ism = await createIsmModule({ config: exampleRoutingConfig });
        const matches = await ismModuleMatchesConfig({
          ism,
          config: exampleRoutingConfig,
          configured: false,
        });
        expect(matches).to.be.true;
      });
    }

    // This test currently fails whenever we have aggregation isms because the
    // comparison for Aggregation ISMs expects the modules to be ordered the same.
    for (let i = 0; i < 16; i++) {
      it(`deploys a random ism config #${i}`, async () => {
        const config = randomIsmConfig();
        let ism: EvmIsmModule;
        try {
          ism = await createIsmModule({ config });
        } catch (e) {
          console.error('Failed to deploy random ism config', e);
          console.error(stringifyObject(config as object, 'json', 2));
          process.exit(1);
        }

        try {
          const matches = await ismModuleMatchesConfig({
            ism,
            config,
            configured: false,
          });
          expect(matches).to.be.true;
        } catch (e) {
          console.error('Failed to match random ism config', e);
          console.error('EXPECTED');
          console.error(stringifyObject(config as object, 'yaml', 2));
          console.error('ACTUAL');
          console.error(
            stringifyObject((await ism.read()) as object, 'yaml', 2),
          );
          process.exit(1);
        }
      });
    }
  });

  describe('update', async () => {
    for (const type of [IsmType.ROUTING, IsmType.FALLBACK_ROUTING]) {
      it(`should skip deployment with warning if no chain metadata configured ${type}`, async () => {
        exampleRoutingConfig.type = type as
          | IsmType.ROUTING
          | IsmType.FALLBACK_ROUTING;
        exampleRoutingConfig.domains['test4'] = {
          type: IsmType.MESSAGE_ID_MULTISIG,
          threshold: 1,
          validators: [randomAddress()],
        };
        const ism = await createIsmModule({ config: exampleRoutingConfig });
        const matches = await ismModuleMatchesConfig({
          ism,
          config: exampleRoutingConfig,
          configured: false,
        });
        expect(matches).to.be.true;

        // txs required to apply the config to the new ISM
        const applyTxs = await ism.update(exampleRoutingConfig);

        exampleRoutingConfig.domains['test5'] = {
          type: IsmType.MESSAGE_ID_MULTISIG,
          threshold: 1,
          validators: [randomAddress()],
        };

        // txs required to apply + add test5 domains
        const updateTxs = await ism.update(exampleRoutingConfig);

        // if adding test5 domains is no-op
        // then updateTxs and applyTxs to have the same length
        expect(updateTxs.length).to.equal(applyTxs.length);
      });
      //     it(`update route in an existing ${type}`, async () => {
      //       exampleRoutingConfig.type = type as
      //         | IsmType.ROUTING
      //         | IsmType.FALLBACK_ROUTING;
      //       let matches = true;
      //       let ism = await ismFactory.deploy({
      //         destination: chain,
      //         config: exampleRoutingConfig,
      //         mailbox: mailboxAddress,
      //       });
      //       const existingIsm = ism.address;
      //       // changing the type of a domain should enroll the domain
      //       (exampleRoutingConfig.domains['test2'] as MultisigIsmConfig).type =
      //         IsmType.MESSAGE_ID_MULTISIG;
      //       ism = await ismFactory.deploy({
      //         destination: chain,
      //         config: exampleRoutingConfig,
      //         existingIsmAddress: ism.address,
      //         mailbox: mailboxAddress,
      //       });
      //       matches =
      //         matches &&
      //         existingIsm === ism.address &&
      //         (await moduleMatchesConfig(
      //           chain,
      //           ism.address,
      //           exampleRoutingConfig,
      //           ismFactory.multiProvider,
      //           ismFactory.getContracts(chain),
      //           mailboxAddress,
      //         ));
      //       expect(matches).to.be.true;
      //     });
      //     it(`deletes route in an existing ${type}`, async () => {
      //       exampleRoutingConfig.type = type as
      //         | IsmType.ROUTING
      //         | IsmType.FALLBACK_ROUTING;
      //       let matches = true;
      //       let ism = await ismFactory.deploy({
      //         destination: chain,
      //         config: exampleRoutingConfig,
      //         mailbox: mailboxAddress,
      //       });
      //       const existingIsm = ism.address;
      //       // deleting the domain should unenroll the domain
      //       delete exampleRoutingConfig.domains['test3'];
      //       ism = await ismFactory.deploy({
      //         destination: chain,
      //         config: exampleRoutingConfig,
      //         existingIsmAddress: ism.address,
      //         mailbox: mailboxAddress,
      //       });
      //       matches =
      //         matches &&
      //         existingIsm == ism.address &&
      //         (await moduleMatchesConfig(
      //           chain,
      //           ism.address,
      //           exampleRoutingConfig,
      //           ismFactory.multiProvider,
      //           ismFactory.getContracts(chain),
      //           mailboxAddress,
      //         ));
      //       expect(matches).to.be.true;
      //     });
      //     it(`deletes route in an existing ${type} even if not in multiprovider`, async () => {
      //       exampleRoutingConfig.type = type as
      //         | IsmType.ROUTING
      //         | IsmType.FALLBACK_ROUTING;
      //       let matches = true;
      //       let ism = await ismFactory.deploy({
      //         destination: chain,
      //         config: exampleRoutingConfig,
      //         mailbox: mailboxAddress,
      //       });
      //       const existingIsm = ism.address;
      //       const domainsBefore = await (ism as DomainRoutingIsm).domains();
      //       // deleting the domain and removing from multiprovider should unenroll the domain
      //       // NB: we'll deploy new multisigIsms for the domains bc of new factories but the routingIsm address should be the same because of existingIsmAddress
      //       delete exampleRoutingConfig.domains['test3'];
      //       multiProvider = multiProvider.intersect([
      //         TestChainName.test1,
      //         'test2',
      //       ]).result;
      //       ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
      //       ismFactory = new HyperlaneIsmFactory(
      //         await ismFactoryDeployer.deploy(
      //           multiProvider.mapKnownChains(() => ({})),
      //         ),
      //         multiProvider,
      //       );
      //       new TestCoreDeployer(multiProvider, ismFactory);
      //       ism = await ismFactory.deploy({
      //         destination: chain,
      //         config: exampleRoutingConfig,
      //         existingIsmAddress: ism.address,
      //         mailbox: mailboxAddress,
      //       });
      //       const domainsAfter = await (ism as DomainRoutingIsm).domains();
      //       matches =
      //         matches &&
      //         existingIsm == ism.address &&
      //         (await moduleMatchesConfig(
      //           chain,
      //           ism.address,
      //           exampleRoutingConfig,
      //           ismFactory.multiProvider,
      //           ismFactory.getContracts(chain),
      //           mailboxAddress,
      //         ));
      //       expect(domainsBefore.length - 1).to.equal(domainsAfter.length);
      //       expect(matches).to.be.true;
      //     });
      //     it(`updates owner in an existing ${type}`, async () => {
      //       exampleRoutingConfig.type = type as
      //         | IsmType.ROUTING
      //         | IsmType.FALLBACK_ROUTING;
      //       let matches = true;
      //       let ism = await ismFactory.deploy({
      //         destination: chain,
      //         config: exampleRoutingConfig,
      //         mailbox: mailboxAddress,
      //       });
      //       const existingIsm = ism.address;
      //       // change the owner
      //       exampleRoutingConfig.owner = randomAddress();
      //       ism = await ismFactory.deploy({
      //         destination: chain,
      //         config: exampleRoutingConfig,
      //         existingIsmAddress: ism.address,
      //         mailbox: mailboxAddress,
      //       });
      //       matches =
      //         matches &&
      //         existingIsm == ism.address &&
      //         (await moduleMatchesConfig(
      //           chain,
      //           ism.address,
      //           exampleRoutingConfig,
      //           ismFactory.multiProvider,
      //           ismFactory.getContracts(chain),
      //           mailboxAddress,
      //         ));
      //       expect(matches).to.be.true;
      //     });
      //     it(`no changes to an existing ${type} means no redeployment or updates`, async () => {
      //       exampleRoutingConfig.type = type as
      //         | IsmType.ROUTING
      //         | IsmType.FALLBACK_ROUTING;
      //       let matches = true;
      //       let ism = await ismFactory.deploy({
      //         destination: chain,
      //         config: exampleRoutingConfig,
      //         mailbox: mailboxAddress,
      //       });
      //       const existingIsm = ism.address;
      //       // using the same config should not change anything
      //       ism = await ismFactory.deploy({
      //         destination: chain,
      //         config: exampleRoutingConfig,
      //         existingIsmAddress: ism.address,
      //         mailbox: mailboxAddress,
      //       });
      //       matches =
      //         matches &&
      //         existingIsm === ism.address &&
      //         (await moduleMatchesConfig(
      //           chain,
      //           ism.address,
      //           exampleRoutingConfig,
      //           ismFactory.multiProvider,
      //           ismFactory.getContracts(chain),
      //           mailboxAddress,
      //         ));
      //       expect(matches).to.be.true;
      //     });
      //     it(`redeploy same config if the deployer doesn't have ownership of ${type}`, async () => {
      //       exampleRoutingConfig.type = type as
      //         | IsmType.ROUTING
      //         | IsmType.FALLBACK_ROUTING;
      //       let matches = true;
      //       exampleRoutingConfig.owner = randomAddress();
      //       let ism = await ismFactory.deploy({
      //         destination: chain,
      //         config: exampleRoutingConfig,
      //         mailbox: mailboxAddress,
      //       });
      //       const existingIsm = ism.address;
      //       ism = await ismFactory.deploy({
      //         destination: chain,
      //         config: exampleRoutingConfig,
      //         existingIsmAddress: ism.address,
      //         mailbox: mailboxAddress,
      //       });
      //       matches =
      //         matches &&
      //         existingIsm !== ism.address &&
      //         (await moduleMatchesConfig(
      //           chain,
      //           ism.address,
      //           exampleRoutingConfig,
      //           ismFactory.multiProvider,
      //           ismFactory.getContracts(chain),
      //           mailboxAddress,
      //         ));
      //       expect(matches).to.be.true;
      //     });
    }
    //   it(`redeploy same config if the mailbox address changes for defaultFallbackRoutingIsm`, async () => {
    //     exampleRoutingConfig.type = IsmType.FALLBACK_ROUTING;
    //     let matches = true;
    //     let ism = await ismFactory.deploy({
    //       destination: chain,
    //       config: exampleRoutingConfig,
    //       mailbox: mailboxAddress,
    //     });
    //     const existingIsm = ism.address;
    //     ism = await ismFactory.deploy({
    //       destination: chain,
    //       config: exampleRoutingConfig,
    //       existingIsmAddress: ism.address,
    //       mailbox: newMailboxAddress,
    //     });
    //     matches =
    //       matches &&
    //       existingIsm !== ism.address &&
    //       (await moduleMatchesConfig(
    //         chain,
    //         ism.address,
    //         exampleRoutingConfig,
    //         ismFactory.multiProvider,
    //         ismFactory.getContracts(chain),
    //         newMailboxAddress,
    //       ));
    //     expect(matches).to.be.true;
    //   });
  });
});
