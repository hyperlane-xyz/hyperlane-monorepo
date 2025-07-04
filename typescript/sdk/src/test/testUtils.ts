import { BigNumber, ethers } from 'ethers';

import { Address, exclude, objMap } from '@hyperlane-xyz/utils';

import { testChains } from '../consts/testChains.js';
import { HyperlaneContractsMap } from '../contracts/types.js';
import { CoreFactories } from '../core/contracts.js';
import { CoreConfig } from '../core/types.js';
import { IgpFactories } from '../gas/contracts.js';
import { IgpConfig } from '../gas/types.js';
import { HookConfig, HookType } from '../hook/types.js';
import {
  AggregationIsmConfig,
  IsmConfig,
  IsmType,
  ModuleType,
  MultisigIsmConfig,
  RoutingIsmConfig,
  TrustedRelayerIsmConfig,
  ismTypeToModuleType,
} from '../ism/types.js';
import { RouterConfig } from '../router/types.js';
import { ChainMap, ChainName } from '../types.js';

export function randomInt(max: number, min = 0): number {
  return Math.floor(Math.random() * (max - min)) + min;
}

export function randomAddress(): Address {
  return ethers.utils.hexlify(ethers.utils.randomBytes(20)).toLowerCase();
}

export function createRouterConfigMap(
  owner: Address,
  coreContracts: HyperlaneContractsMap<CoreFactories>,
  igpContracts: HyperlaneContractsMap<IgpFactories>,
): ChainMap<RouterConfig> {
  return objMap(coreContracts, (chain, contracts) => {
    return {
      owner,
      mailbox: contracts.mailbox.address,
      interchainGasPaymaster:
        igpContracts[chain].interchainGasPaymaster.address,
    };
  });
}

const nonZeroAddress = ethers.constants.AddressZero.replace('00', '01');

// dummy config as TestInbox and TestOutbox do not use deployed ISM
export function testCoreConfig(
  chains: ChainName[],
  owner = nonZeroAddress,
): ChainMap<CoreConfig> {
  const chainConfig: CoreConfig = {
    owner,
    defaultIsm: {
      type: IsmType.TEST_ISM,
    },
    defaultHook: {
      type: HookType.MERKLE_TREE,
    },
    requiredHook: {
      type: HookType.PROTOCOL_FEE,
      maxProtocolFee: ethers.utils.parseUnits('1', 'gwei').toString(), // 1 gwei of native token
      protocolFee: BigNumber.from(1).toString(), // 1 wei
      beneficiary: nonZeroAddress,
      owner,
    },
  };

  return Object.fromEntries(chains.map((local) => [local, chainConfig]));
}

const TEST_ORACLE_CONFIG = {
  gasPrice: ethers.utils.parseUnits('1', 'gwei').toString(),
  tokenExchangeRate: ethers.utils.parseUnits('1', 10).toString(),
  tokenDecimals: 18,
};

const TEST_OVERHEAD_COST = 60000;

export function testIgpConfig(
  chains: ChainName[],
  owner = nonZeroAddress,
): ChainMap<IgpConfig> {
  return Object.fromEntries(
    chains.map((local) => {
      const overhead: IgpConfig['overhead'] = {};
      const oracleConfig: IgpConfig['oracleConfig'] = {};
      exclude(local, chains).map((remote: ChainName) => {
        overhead[remote] = TEST_OVERHEAD_COST;
        oracleConfig[remote] = TEST_ORACLE_CONFIG;
      });
      return [
        local,
        {
          type: HookType.INTERCHAIN_GAS_PAYMASTER,
          owner,
          oracleKey: owner,
          beneficiary: owner,
          overhead,
          oracleConfig,
        },
      ];
    }),
  );
}

export const hookTypes = Object.values(HookType);
export const hookTypesToFilter = [
  HookType.OP_STACK,
  HookType.ARB_L2_TO_L1,
  HookType.CUSTOM,
  HookType.CCIP,
];
export const DEFAULT_TOKEN_DECIMALS = 18;

function randomHookType(): HookType {
  // OP_STACK filtering is temporary until we have a way to deploy the required contracts
  // ARB_L2_TO_L1 filtered out until we have a way to deploy the required contracts (arbL2ToL1.hardhat-test.ts has the same test for checking deployment)
  const filteredHookTypes = hookTypes.filter(
    (type) => !hookTypesToFilter.includes(type),
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

export function randomHookConfig(
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
    case HookType.MAILBOX_DEFAULT:
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
              tokenExchangeRate: randomInt(1234567891234).toString(),
              gasPrice: randomInt(1234567891234).toString(),
              tokenDecimals: DEFAULT_TOKEN_DECIMALS,
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

    case HookType.ARB_L2_TO_L1:
      return {
        type: hookType,
        arbSys: randomAddress(),
        bridge: randomAddress(),
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
        paused: false,
      };

    case HookType.AMOUNT_ROUTING:
      return {
        type: hookType,
        threshold: Math.floor(Math.random() * 100),
        lowerHook: randomHookConfig(depth + 1, maxDepth),
        upperHook: randomHookConfig(depth + 1, maxDepth),
      };

    default:
      throw new Error(`Unsupported Hook type: ${hookType}`);
  }
}

export const randomMultisigIsmConfig = (
  m: number,
  n: number,
): MultisigIsmConfig => {
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

export const randomIsmConfig = (
  depth = 0,
  maxDepth = 2,
  providedIsmType?: IsmType,
): Exclude<IsmConfig, string> => {
  // Use input IsmType, otherwise randomize a config based on depth
  const moduleType = providedIsmType
    ? ismTypeToModuleType(providedIsmType)
    : depth === maxDepth
      ? randomNonNestedModuleType()
      : randomModuleType();

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
