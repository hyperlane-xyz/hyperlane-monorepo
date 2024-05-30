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
import { CoreAddresses } from '../core/contracts.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { randomAddress, randomInt } from '../test/testUtils.js';

import { EvmHookModule } from './EvmHookModule.js';
import { HyperlaneHookDeployer } from './HyperlaneHookDeployer.js';
import {
  AggregationHookConfig,
  DomainRoutingHookConfig,
  FallbackRoutingHookConfig,
  HookConfig,
  HookType,
  IgpHookConfig,
  MerkleTreeHookConfig,
  PausableHookConfig,
} from './types.js';

const hookTypes = Object.values(HookType);

function randomHookType(): HookType {
  // OP_STACK filtering is temporary until we have a way to deploy the required contracts
  // PROTOCOL_FEE filtering is temporary until we fix initialization of the protocol fee hook
  // ROUTING/FALLBACK_ROUTING filtering is temporary until we fix ownership of domain hooks
  const filteredHookTypes = hookTypes.filter(
    (type) =>
      type !== HookType.OP_STACK &&
      type !== HookType.ROUTING &&
      type !== HookType.FALLBACK_ROUTING,
  );
  return filteredHookTypes[
    Math.floor(Math.random() * filteredHookTypes.length)
  ];
}

function randomProtocolFee(): { maxProtocolFee: string; protocolFee: string } {
  const maxProtocolFee = Math.random() * 100000000000000;
  const protocolFee = (Math.random() * maxProtocolFee) / 1000;
  return {
    maxProtocolFee: Math.floor(maxProtocolFee).toString(),
    protocolFee: Math.floor(protocolFee).toString(),
  };
}

function randomHookConfig(
  depth = 0,
  maxDepth = 2,
  providedHookType?: HookType,
): HookConfig {
  const hookType: HookType = providedHookType ?? randomHookType();

  if (depth >= maxDepth) {
    if (
      hookType === HookType.AGGREGATION ||
      hookType === HookType.ROUTING ||
      hookType === HookType.FALLBACK_ROUTING
    ) {
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

    case HookType.PROTOCOL_FEE: {
      const { maxProtocolFee, protocolFee } = randomProtocolFee();
      return {
        owner: randomAddress(),
        type: hookType,
        maxProtocolFee,
        protocolFee,
        beneficiary: randomAddress(),
      };
    }

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

  let coreAddresses: CoreAddresses;

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
    const { mailbox, proxyAdmin, validatorAnnounce } = (
      await testCoreDeployer.deployApp()
    ).getContracts(chain);

    coreAddresses = {
      mailbox: mailbox.address,
      proxyAdmin: proxyAdmin.address,
      validatorAnnounce: validatorAnnounce.address,
    };

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
        'Derived config:\n',
        stringifyObject(normalizeConfig(derivedConfig)),
      );
      console.error(
        'Expected config:\n',
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
    console.log('Creating hook with config: ', stringifyObject(config));
    const hook = await EvmHookModule.create({
      chain,
      config,
      deployer: hookDeployer,
      factories: factoryAddresses,
      coreAddresses,
      multiProvider,
    });
    testConfig = config;
    testHook = hook;
    return { ism: hook, initialHookAddress: hook.serialize().deployedHook };
  }

  describe('create', async () => {
    it('deploys a hook of type MERKLE_TREE', async () => {
      const config: MerkleTreeHookConfig = {
        type: HookType.MERKLE_TREE,
      };
      await createHook(config);
    });

    it('deploys a hook of type INTERCHAIN_GAS_PAYMASTER', async () => {
      const owner = randomAddress();
      const config: IgpHookConfig = {
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
              tokenExchangeRate: BigNumber.from(randomInt(1234567891234)),
              gasPrice: BigNumber.from(randomInt(1234567891234)),
            },
          ]),
        ),
      };
      await createHook(config);
    });

    // it('deploys a hook of type PROTOCOL_FEE', async () => {
    //   const { maxProtocolFee, protocolFee } = randomProtocolFee();
    //   const config: ProtocolFeeHookConfig = {
    //     owner: randomAddress(),
    //     type: HookType.PROTOCOL_FEE,
    //     maxProtocolFee,
    //     protocolFee,
    //     beneficiary: randomAddress(),
    //   };
    //   await createHook(config);
    // });

    it('deploys a hook of type ROUTING', async () => {
      const config: DomainRoutingHookConfig = {
        owner: randomAddress(),
        type: HookType.ROUTING,
        domains: Object.fromEntries(
          testChains.map((c) => [
            c,
            {
              type: HookType.MERKLE_TREE,
            },
          ]),
        ),
      };
      await createHook(config);
    });

    it('deploys a hook of type FALLBACK_ROUTING', async () => {
      const config: FallbackRoutingHookConfig = {
        owner: randomAddress(),
        type: HookType.FALLBACK_ROUTING,
        fallback: { type: HookType.MERKLE_TREE },
        domains: Object.fromEntries(
          testChains.map((c) => [
            c,
            {
              type: HookType.MERKLE_TREE,
            },
          ]),
        ),
      };
      await createHook(config);
    });

    it('deploys a hook of type AGGREGATION', async () => {
      const config: AggregationHookConfig = {
        type: HookType.AGGREGATION,
        hooks: [{ type: HookType.MERKLE_TREE }, { type: HookType.MERKLE_TREE }],
      };
      await createHook(config);
    });

    it('deploys a hook of type PAUSABLE', async () => {
      const config: PausableHookConfig = {
        owner: randomAddress(),
        type: HookType.PAUSABLE,
      };
      await createHook(config);
    });

    // it('deploys a hook of type OP_STACK', async () => {
    // need to setup deploying/mocking IL1CrossDomainMessenger before this test can be enabled
    //   const config: OpStackHookConfig = {
    //     owner: randomAddress(),
    //     type: HookType.OP_STACK,
    //     nativeBridge: randomAddress(),
    //     destinationChain: 'testChain',
    //   };
    //   await createHook(config);
    // });

    for (let i = 0; i < 16; i++) {
      it(`deploys a random ism config #${i}`, async () => {
        // random config with depth 0-2
        const config = randomHookConfig();
        await createHook(config);
      });
    }
  });
});
