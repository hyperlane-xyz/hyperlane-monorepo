import { testChains } from '../consts/testChains.js';
import { HookConfig, HookType } from '../hook/types.js';

import { randomAddress, randomInt } from './testUtils.js';

export const hookTypes = Object.values(HookType);
export const hookTypesToFilter = [
  HookType.OP_STACK,
  HookType.ARB_L2_TO_L1,
  HookType.CUSTOM,
  HookType.CCIP,
];
const DEFAULT_TOKEN_DECIMALS = 18;

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
export { randomInt, DEFAULT_TOKEN_DECIMALS };
