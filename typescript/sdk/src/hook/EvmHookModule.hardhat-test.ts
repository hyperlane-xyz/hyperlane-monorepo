/* eslint-disable no-console */
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import hre from 'hardhat';

import {
  Address,
  configDeepEquals,
  normalizeConfig,
  stringifyObject,
} from '@hyperlane-xyz/utils';

import { TestChainName, testChains } from '../consts/testChains.js';
import { HyperlaneAddresses, HyperlaneContracts } from '../contracts/types.js';
import { TestCoreDeployer } from '../core/TestCoreDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { randomAddress, randomInt } from '../test/testUtils.js';

import { EvmHookModule } from './EvmHookModule.js';
import { HyperlaneHookDeployer } from './HyperlaneHookDeployer.js';
import { HookConfig, HookType } from './types.js';

const hookTypes = Object.values(HookType);

function randomHookType(): HookType {
  const filteredHookTypes = hookTypes.filter(
    (type) => type !== HookType.OP_STACK,
  );
  return filteredHookTypes[
    Math.floor(Math.random() * filteredHookTypes.length)
  ];
}

function randomHookConfig(
  depth = 0,
  maxDepth = 2,
  providedHookType?: HookType,
): HookConfig {
  const hookType: HookType = providedHookType ?? randomHookType();

  if (depth >= maxDepth) {
    if (hookType === HookType.AGGREGATION || hookType === HookType.ROUTING) {
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
              tokenExchangeRate: BigNumber.from(randomInt(1234567891234)),
              gasPrice: BigNumber.from(randomInt(1234567891234)),
            },
          ]),
        ),
      };
    }

    case HookType.PROTOCOL_FEE:
      return {
        owner: randomAddress(),
        type: hookType,
        maxProtocolFee: Math.floor(Math.random() * 1000).toString(),
        protocolFee: Math.floor(Math.random() * 100).toString(),
        beneficiary: randomAddress(),
      };

    case HookType.OP_STACK:
      return {
        owner: randomAddress(),
        type: hookType,
        nativeBridge: randomAddress(),
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
      };

    default:
      throw new Error(`Unsupported Hook type: ${hookType}`);
  }
}

describe('EvmHookModule', async () => {
  let multiProvider: MultiProvider;
  let hookDeployer: HyperlaneHookDeployer;

  let mailboxAddress: Address;
  let proxyAdminAddress: Address;

  const chain = TestChainName.test4;
  let factoryAddresses: HyperlaneAddresses<ProxyFactoryFactories>;
  let factoryContracts: HyperlaneContracts<ProxyFactoryFactories>;

  beforeEach(async () => {
    const [signer] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });

    const ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
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

    // core deployer for tests
    const testCoreDeployer = new TestCoreDeployer(
      multiProvider,
      legacyIsmFactory,
    );

    // mailbox and proxy admin for the core deploy
    const { mailbox, proxyAdmin } = (
      await testCoreDeployer.deployApp()
    ).getContracts(chain);
    mailboxAddress = mailbox.address;
    proxyAdminAddress = proxyAdmin.address;

    hookDeployer = testCoreDeployer.hookDeployer;
  });

  // Helper method for checking whether ISM module matches a given config
  async function hookModuleMatchesConfig({
    hook,
    config,
  }: {
    hook: EvmHookModule;
    config: HookConfig;
  }): Promise<boolean> {
    const derivedConfig = await hook.read();
    const matches = configDeepEquals(
      normalizeConfig(derivedConfig),
      normalizeConfig(config),
    );
    if (!matches) {
      console.error(
        'Derived config:',
        stringifyObject(normalizeConfig(derivedConfig)),
      );
      console.error(
        'Expected config:',
        stringifyObject(normalizeConfig(config)),
      );
    }
    return matches;
  }

  // hook module and config for testing
  let testHook: EvmHookModule;
  let testConfig: HookConfig;

  // expect that the hook matches the config after all tests
  afterEach(async () => {
    expect(
      await hookModuleMatchesConfig({ hook: testHook, config: testConfig }),
    ).to.be.true;
  });

  // create a new ISM and verify that it matches the config
  async function createHook(
    config: HookConfig,
  ): Promise<{ ism: EvmHookModule; initialHookAddress: Address }> {
    const hook = await EvmHookModule.create({
      chain,
      config,
      deployer: hookDeployer,
      factories: factoryAddresses,
      mailbox: mailboxAddress,
      proxyAdmin: proxyAdminAddress,
      multiProvider,
    });
    testHook = hook;
    testConfig = config;
    return { ism: hook, initialHookAddress: hook.serialize().deployedHook };
  }

  describe('create', async () => {
    for (const hookType of Object.values(HookType)) {
      if (hookType === HookType.OP_STACK) {
        console.log('Skipping OP_STACK hook type');
        continue;
      }

      it(`deploys a hook of type ${hookType}`, async () => {
        const config = randomHookConfig(0, 2, hookType);
        console.log('Creating hook with config:', config);
        await createHook(config);
      });
    }

    for (let i = 0; i < 16; i++) {
      it(`deploys a random ism config #${i}`, async () => {
        const config = randomHookConfig();
        console.log('Creating hook with config:', config);
        await createHook(config);
      });
    }
  });
});
