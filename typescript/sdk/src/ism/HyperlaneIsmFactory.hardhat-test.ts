/* eslint-disable no-console */
import { expect } from 'chai';
import hre from 'hardhat';

import { DomainRoutingIsm } from '@hyperlane-xyz/core';
import { Address } from '@hyperlane-xyz/utils';

import { TestChains } from '../consts/chains.js';
import { TestCoreApp } from '../core/TestCoreApp.js';
import { TestCoreDeployer } from '../core/TestCoreDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { randomAddress, randomInt } from '../test/testUtils.js';

import { HyperlaneIsmFactory } from './HyperlaneIsmFactory.js';
import {
  AggregationIsmConfig,
  IsmConfig,
  IsmType,
  ModuleType,
  MultisigIsmConfig,
  RoutingIsmConfig,
} from './types.js';
import { moduleMatchesConfig } from './utils.js';

function randomModuleType(): ModuleType {
  const choices = [
    ModuleType.AGGREGATION,
    ModuleType.MERKLE_ROOT_MULTISIG,
    ModuleType.ROUTING,
  ];
  return choices[randomInt(choices.length)];
}

const randomMultisigIsmConfig = (m: number, n: number): MultisigIsmConfig => {
  const emptyArray = new Array<number>(n).fill(0);
  const validators = emptyArray.map(() => randomAddress());
  return {
    type: IsmType.MERKLE_ROOT_MULTISIG,
    validators,
    threshold: m,
  };
};

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
        TestChains.map((c) => [c, randomIsmConfig(depth + 1)]),
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
  } else {
    throw new Error(`Unsupported ISM type: ${moduleType}`);
  }
};

describe('HyperlaneIsmFactory', async () => {
  let ismFactory: HyperlaneIsmFactory;
  let coreApp: TestCoreApp;
  let multiProvider: MultiProvider;
  let ismFactoryDeployer: HyperlaneProxyFactoryDeployer;
  let exampleRoutingConfig: RoutingIsmConfig;
  let mailboxAddress: Address, newMailboxAddress: Address;
  const chain = 'test1';

  beforeEach(async () => {
    const [signer] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
    ismFactory = new HyperlaneIsmFactory(
      await ismFactoryDeployer.deploy(multiProvider.mapKnownChains(() => ({}))),
      multiProvider,
    );
    let coreDeployer = new TestCoreDeployer(multiProvider, ismFactory);
    coreApp = await coreDeployer.deployApp();
    mailboxAddress = coreApp.getContracts(chain).mailbox.address;

    coreDeployer = new TestCoreDeployer(multiProvider, ismFactory);
    coreApp = await coreDeployer.deployApp();
    newMailboxAddress = coreApp.getContracts(chain).mailbox.address;

    exampleRoutingConfig = {
      type: IsmType.ROUTING,
      owner: await multiProvider.getSignerAddress(chain),
      domains: Object.fromEntries(
        TestChains.filter((c) => c !== 'test1').map((c) => [
          c,
          randomMultisigIsmConfig(3, 5),
        ]),
      ),
    };
  });

  it('deploys a simple ism', async () => {
    const config = randomMultisigIsmConfig(3, 5);
    const ism = await ismFactory.deploy({ destination: chain, config });
    const matches = await moduleMatchesConfig(
      chain,
      ism.address,
      config,
      ismFactory.multiProvider,
      ismFactory.getContracts(chain),
    );
    expect(matches).to.be.true;
  });

  for (let i = 0; i < 16; i++) {
    it('deploys a random ism config', async () => {
      const config = randomIsmConfig();
      let ismAddress: string;
      try {
        const ism = await ismFactory.deploy({ destination: chain, config });
        ismAddress = ism.address;
      } catch (e) {
        console.error('Failed to deploy random ism config', e);
        console.error(JSON.stringify(config, null, 2));
        process.exit(1);
      }

      try {
        const matches = await moduleMatchesConfig(
          chain,
          ismAddress,
          config,
          ismFactory.multiProvider,
          ismFactory.getContracts(chain),
        );
        expect(matches).to.be.true;
      } catch (e) {
        console.error('Failed to match random ism config', e);
        console.error(JSON.stringify(config, null, 2));
        process.exit(1);
      }
    });
  }

  for (const type of [IsmType.ROUTING, IsmType.FALLBACK_ROUTING]) {
    it(`deploys ${type} routingIsm with correct routes`, async () => {
      exampleRoutingConfig.type = type as
        | IsmType.ROUTING
        | IsmType.FALLBACK_ROUTING;
      const ism = await ismFactory.deploy({
        destination: chain,
        config: exampleRoutingConfig,
        mailbox: mailboxAddress,
      });
      const matches = await moduleMatchesConfig(
        chain,
        ism.address,
        exampleRoutingConfig,
        ismFactory.multiProvider,
        ismFactory.getContracts(chain),
        mailboxAddress,
      );
      expect(matches).to.be.true;
    });

    it(`update route in an existing ${type}`, async () => {
      exampleRoutingConfig.type = type as
        | IsmType.ROUTING
        | IsmType.FALLBACK_ROUTING;
      let matches = true;
      let ism = await ismFactory.deploy({
        destination: chain,
        config: exampleRoutingConfig,
        mailbox: mailboxAddress,
      });
      const existingIsm = ism.address;
      // changing the type of a domain should enroll the domain
      (exampleRoutingConfig.domains['test2'] as MultisigIsmConfig).type =
        IsmType.MESSAGE_ID_MULTISIG;
      ism = await ismFactory.deploy({
        destination: chain,
        config: exampleRoutingConfig,
        existingIsmAddress: ism.address,
        mailbox: mailboxAddress,
      });
      matches =
        matches &&
        existingIsm === ism.address &&
        (await moduleMatchesConfig(
          chain,
          ism.address,
          exampleRoutingConfig,
          ismFactory.multiProvider,
          ismFactory.getContracts(chain),
          mailboxAddress,
        ));
      expect(matches).to.be.true;
    });

    it(`should skip deployment with warning if no chain metadata configured ${type}`, async () => {
      exampleRoutingConfig.type = type as
        | IsmType.ROUTING
        | IsmType.FALLBACK_ROUTING;
      let matches = true;
      exampleRoutingConfig.domains['test4'] = {
        type: IsmType.MESSAGE_ID_MULTISIG,
        threshold: 1,
        validators: [randomAddress()],
      };
      let ism = await ismFactory.deploy({
        destination: chain,
        config: exampleRoutingConfig,
        mailbox: mailboxAddress,
      });
      const existingIsm = ism.address;
      matches =
        matches &&
        existingIsm === ism.address &&
        (await moduleMatchesConfig(
          chain,
          ism.address,
          exampleRoutingConfig,
          ismFactory.multiProvider,
          ismFactory.getContracts(chain),
          mailboxAddress,
        ));

      exampleRoutingConfig.domains['test5'] = {
        type: IsmType.MESSAGE_ID_MULTISIG,
        threshold: 1,
        validators: [randomAddress()],
      };
      ism = await ismFactory.deploy({
        destination: chain,
        config: exampleRoutingConfig,
        existingIsmAddress: ism.address,
        mailbox: mailboxAddress,
      });
      matches =
        matches &&
        existingIsm === ism.address &&
        (await moduleMatchesConfig(
          chain,
          ism.address,
          exampleRoutingConfig,
          ismFactory.multiProvider,
          ismFactory.getContracts(chain),
          mailboxAddress,
        ));
      expect(matches).to.be.true;
    });

    it(`deletes route in an existing ${type}`, async () => {
      exampleRoutingConfig.type = type as
        | IsmType.ROUTING
        | IsmType.FALLBACK_ROUTING;
      let matches = true;
      let ism = await ismFactory.deploy({
        destination: chain,
        config: exampleRoutingConfig,
        mailbox: mailboxAddress,
      });
      const existingIsm = ism.address;
      // deleting the domain should unenroll the domain
      delete exampleRoutingConfig.domains['test3'];
      ism = await ismFactory.deploy({
        destination: chain,
        config: exampleRoutingConfig,
        existingIsmAddress: ism.address,
        mailbox: mailboxAddress,
      });
      matches =
        matches &&
        existingIsm == ism.address &&
        (await moduleMatchesConfig(
          chain,
          ism.address,
          exampleRoutingConfig,
          ismFactory.multiProvider,
          ismFactory.getContracts(chain),
          mailboxAddress,
        ));
      expect(matches).to.be.true;
    });

    it(`deletes route in an existing ${type} even if not in multiprovider`, async () => {
      exampleRoutingConfig.type = type as
        | IsmType.ROUTING
        | IsmType.FALLBACK_ROUTING;
      let matches = true;
      let ism = await ismFactory.deploy({
        destination: chain,
        config: exampleRoutingConfig,
        mailbox: mailboxAddress,
      });
      const existingIsm = ism.address;
      const domainsBefore = await (ism as DomainRoutingIsm).domains();

      // deleting the domain and removing from multiprovider should unenroll the domain
      // NB: we'll deploy new multisigIsms for the domains bc of new factories but the routingIsm address should be the same because of existingIsmAddress
      delete exampleRoutingConfig.domains['test3'];
      multiProvider = multiProvider.intersect(['test1', 'test2']).result;
      ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
      ismFactory = new HyperlaneIsmFactory(
        await ismFactoryDeployer.deploy(
          multiProvider.mapKnownChains(() => ({})),
        ),
        multiProvider,
      );
      new TestCoreDeployer(multiProvider, ismFactory);
      ism = await ismFactory.deploy({
        destination: chain,
        config: exampleRoutingConfig,
        existingIsmAddress: ism.address,
        mailbox: mailboxAddress,
      });
      const domainsAfter = await (ism as DomainRoutingIsm).domains();

      matches =
        matches &&
        existingIsm == ism.address &&
        (await moduleMatchesConfig(
          chain,
          ism.address,
          exampleRoutingConfig,
          ismFactory.multiProvider,
          ismFactory.getContracts(chain),
          mailboxAddress,
        ));
      expect(domainsBefore.length - 1).to.equal(domainsAfter.length);
      expect(matches).to.be.true;
    });

    it(`updates owner in an existing ${type}`, async () => {
      exampleRoutingConfig.type = type as
        | IsmType.ROUTING
        | IsmType.FALLBACK_ROUTING;
      let matches = true;
      let ism = await ismFactory.deploy({
        destination: chain,
        config: exampleRoutingConfig,
        mailbox: mailboxAddress,
      });
      const existingIsm = ism.address;
      // change the owner
      exampleRoutingConfig.owner = randomAddress();
      ism = await ismFactory.deploy({
        destination: chain,
        config: exampleRoutingConfig,
        existingIsmAddress: ism.address,
        mailbox: mailboxAddress,
      });
      matches =
        matches &&
        existingIsm == ism.address &&
        (await moduleMatchesConfig(
          chain,
          ism.address,
          exampleRoutingConfig,
          ismFactory.multiProvider,
          ismFactory.getContracts(chain),
          mailboxAddress,
        ));
      expect(matches).to.be.true;
    });

    it(`no changes to an existing ${type} means no redeployment or updates`, async () => {
      exampleRoutingConfig.type = type as
        | IsmType.ROUTING
        | IsmType.FALLBACK_ROUTING;
      let matches = true;
      let ism = await ismFactory.deploy({
        destination: chain,
        config: exampleRoutingConfig,
        mailbox: mailboxAddress,
      });
      const existingIsm = ism.address;
      // using the same config should not change anything
      ism = await ismFactory.deploy({
        destination: chain,
        config: exampleRoutingConfig,
        existingIsmAddress: ism.address,
        mailbox: mailboxAddress,
      });
      matches =
        matches &&
        existingIsm === ism.address &&
        (await moduleMatchesConfig(
          chain,
          ism.address,
          exampleRoutingConfig,
          ismFactory.multiProvider,
          ismFactory.getContracts(chain),
          mailboxAddress,
        ));
      expect(matches).to.be.true;
    });

    it(`redeploy same config if the deployer doesn't have ownership of ${type}`, async () => {
      exampleRoutingConfig.type = type as
        | IsmType.ROUTING
        | IsmType.FALLBACK_ROUTING;
      let matches = true;
      exampleRoutingConfig.owner = randomAddress();
      let ism = await ismFactory.deploy({
        destination: chain,
        config: exampleRoutingConfig,
        mailbox: mailboxAddress,
      });
      const existingIsm = ism.address;
      ism = await ismFactory.deploy({
        destination: chain,
        config: exampleRoutingConfig,
        existingIsmAddress: ism.address,
        mailbox: mailboxAddress,
      });
      matches =
        matches &&
        existingIsm !== ism.address &&
        (await moduleMatchesConfig(
          chain,
          ism.address,
          exampleRoutingConfig,
          ismFactory.multiProvider,
          ismFactory.getContracts(chain),
          mailboxAddress,
        ));
      expect(matches).to.be.true;
    });
  }

  it(`redeploy same config if the mailbox address changes for defaultFallbackRoutingIsm`, async () => {
    exampleRoutingConfig.type = IsmType.FALLBACK_ROUTING;
    let matches = true;
    let ism = await ismFactory.deploy({
      destination: chain,
      config: exampleRoutingConfig,
      mailbox: mailboxAddress,
    });
    const existingIsm = ism.address;
    ism = await ismFactory.deploy({
      destination: chain,
      config: exampleRoutingConfig,
      existingIsmAddress: ism.address,
      mailbox: newMailboxAddress,
    });
    matches =
      matches &&
      existingIsm !== ism.address &&
      (await moduleMatchesConfig(
        chain,
        ism.address,
        exampleRoutingConfig,
        ismFactory.multiProvider,
        ismFactory.getContracts(chain),
        newMailboxAddress,
      ));
    expect(matches).to.be.true;
  });
});
