import { expect } from 'chai';
import { ethers } from 'hardhat';

import { Address, error } from '@hyperlane-xyz/utils';

import { TestChains } from '../consts/chains';
import { TestCoreApp } from '../core/TestCoreApp';
import { TestCoreDeployer } from '../core/TestCoreDeployer';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer';
import { MultiProvider } from '../providers/MultiProvider';
import { randomAddress, randomInt } from '../test/testUtils';

import {
  HyperlaneIsmFactory,
  moduleMatchesConfig,
} from './HyperlaneIsmFactory';
import {
  AggregationIsmConfig,
  IsmConfig,
  IsmType,
  ModuleType,
  MultisigIsmConfig,
  RoutingIsmConfig,
} from './types';

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
  let exampleRoutingConfig: RoutingIsmConfig;
  let mailboxAddress: Address, newMailboxAddress: Address;
  const chain = 'test1';

  beforeEach(async () => {
    const [signer] = await ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    const ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
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
        error('Failed to deploy random ism config', e);
        error(JSON.stringify(config, null, 2));
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
        error('Failed to match random ism config', e);
        error(JSON.stringify(config, null, 2));
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
