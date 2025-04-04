import { ethers } from 'ethers';

import {
  ChainMap,
  HookConfig,
  HookType,
  HypTokenRouterConfig,
  IsmConfig,
  IsmType,
  TokenType,
  XERC20LimitConfig,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

// Environment-independent configuration
const deploymentChains = [
  'celo',
  'optimism',
  'base',
  'unichain',
  'ink',
  'soneium',
  'mode',
  'fraxtal',
  'superseed',
  'lisk',
  'worldchain',
] as const;
const supportedCCIPChains = ['base', 'mode', 'optimism'];
const xERC20LockboxChain: SuperTokenChainName = 'celo';

type SuperTokenChainName = (typeof deploymentChains)[number];
type TypedSuperTokenChainMap<T> = {
  [Key in SuperTokenChainName]: T;
};

// Environment-specific configuration

// Production
const upperBufferCap = '20000000000000'; // 20M = 20 * 10^6 ^ 10^6
const lowerBufferCap = '2000000000000'; // 2M = 10 * 10^6 ^ 10^6
const productionBufferCapByChain: TypedSuperTokenChainMap<string> = {
  celo: upperBufferCap,
  optimism: upperBufferCap,
  base: upperBufferCap,
  unichain: upperBufferCap,
  ink: '0',
  soneium: lowerBufferCap,
  mode: lowerBufferCap,
  fraxtal: lowerBufferCap,
  superseed: lowerBufferCap,
  lisk: lowerBufferCap,
  worldchain: '0',
};
const productionDefaultRateLimitPerSecond = '5000000000'; // 5k/s = 5 * 10^3 ^ 10^6
const lowerRateLimitPerSecond = '500000000'; // 0.5k/s = 0.5 * 10^3 ^ 10^6
const productionRateLimitByChain: TypedSuperTokenChainMap<string> = {
  celo: productionDefaultRateLimitPerSecond,
  optimism: productionDefaultRateLimitPerSecond,
  base: productionDefaultRateLimitPerSecond,
  unichain: productionDefaultRateLimitPerSecond,
  ink: '0',
  soneium: lowerRateLimitPerSecond,
  mode: lowerRateLimitPerSecond,
  fraxtal: lowerRateLimitPerSecond,
  superseed: lowerRateLimitPerSecond,
  lisk: lowerRateLimitPerSecond,
  worldchain: '0',
};

const productionOwnerByChain: TypedSuperTokenChainMap<string> = {
  celo: '0xf1b3fc934bB46c459253fb38555A400b94909800',
  optimism: '0x8E3340E241880F80359AA95Ae20Dc498d3f62503',
  base: '0x125d1b64dfd7898DD06ac3E060A432691b8Fa676',
  unichain: '0xf306ad5bF95960188c67A30f5546D193760ca3D0',
  ink: '0x1BBf2CE75A77b8A10dA7e73dC1F76456008010bD',
  soneium: '0x31Bf112F33556A0F1dc76881cfA8A36Bc2134A57',
  mode: '0xD4c01B4753575899AD81aAca0bb2DB7796E9F7C0',
  fraxtal: '0x21C0CA5be5aC9BC6161Bf1cfE281A18Fe2190079',
  superseed: '0x0731a8e0DC88Df79d9643BD6C1f26cfe6fa53382',
  lisk: '0x6F0A0038FcDB2F1655219f1b92f7E9aD4b78Aa49',
  worldchain: '0x998238aF5A2DDC7ae08Dbe4B60b82EF63A1538cd',
};

const productionOwnerOverridesByChain: ChainMap<
  Record<'collateralToken' | 'collateralProxyAdmin', string>
> = {
  celo: {
    collateralToken: productionOwnerByChain.celo,
    collateralProxyAdmin: productionOwnerByChain.celo,
  },
  optimism: {
    collateralToken: productionOwnerByChain.optimism,
    collateralProxyAdmin: productionOwnerByChain.optimism,
  },
  base: {
    collateralToken: productionOwnerByChain.base,
    collateralProxyAdmin: productionOwnerByChain.base,
  },
  unichain: {
    collateralToken: productionOwnerByChain.unichain,
    collateralProxyAdmin: productionOwnerByChain.unichain,
  },
  ink: {
    collateralToken: productionOwnerByChain.ink,
    collateralProxyAdmin: productionOwnerByChain.ink,
  },
  soneium: {
    collateralToken: productionOwnerByChain.soneium,
    collateralProxyAdmin: productionOwnerByChain.soneium,
  },
  mode: {
    collateralToken: productionOwnerByChain.mode,
    collateralProxyAdmin: productionOwnerByChain.mode,
  },
  fraxtal: {
    collateralToken: productionOwnerByChain.fraxtal,
    collateralProxyAdmin: productionOwnerByChain.fraxtal,
  },
  superseed: {
    collateralToken: productionOwnerByChain.superseed,
    collateralProxyAdmin: productionOwnerByChain.superseed,
  },
  lisk: {
    collateralToken: productionOwnerByChain.lisk,
    collateralProxyAdmin: productionOwnerByChain.lisk,
  },
  worldchain: {
    collateralToken: productionOwnerByChain.worldchain,
    collateralProxyAdmin: productionOwnerByChain.worldchain,
  },
};

const productionAmountRoutingThreshold = 250000000000; // 250k = 250 * 10^3 ^ 10^6
const productionXERC20LockboxAddress =
  '0x5e5F4d6B03db16E7f00dE7C9AFAA53b92C8d1D42';
const productionXERC20TokenAddress =
  '0x1217BfE6c773EEC6cc4A38b5Dc45B92292B6E189';

const productionExtraLockboxLimits: XERC20LimitConfig = {
  bufferCap: upperBufferCap,
  rateLimitPerSecond: productionDefaultRateLimitPerSecond,
};

const zeroLimits: XERC20LimitConfig = {
  bufferCap: '0',
  rateLimitPerSecond: '0',
};

const productionExtraLockboxes = {
  base: [
    {
      // usdt
      lockbox: '0x9d922c23d78179c2e75fe394fc8e49363f2dda85',
      limits: zeroLimits,
    },
    {
      // usdc
      lockbox: '0xe92e51d99ae33114c60d9621fb2e1ec0acea7e30',
      limits: productionExtraLockboxLimits,
    },
  ],
  optimism: [
    {
      // usdc
      lockbox: '0x07e437d73e9e43ceece6ea14085b26159e3f7f31',
      limits: zeroLimits,
    },
    {
      // usdt
      lockbox: '0x18c4cdc2d774c047eac8375bb09853c4d6d6df36',
      limits: productionExtraLockboxLimits,
    },
  ],
};

const productionXERC20AddressesByChain: TypedSuperTokenChainMap<Address> = {
  celo: productionXERC20LockboxAddress,
  optimism: productionXERC20TokenAddress,
  base: productionXERC20TokenAddress,
  unichain: productionXERC20TokenAddress,
  ink: productionXERC20TokenAddress,
  soneium: productionXERC20TokenAddress,
  mode: productionXERC20TokenAddress,
  fraxtal: productionXERC20TokenAddress,
  superseed: productionXERC20TokenAddress,
  lisk: productionXERC20TokenAddress,
  worldchain: productionXERC20TokenAddress,
};

// Staging
const stagingDefaultBufferCap = '25000000000';
const stagingBufferCapByChain: TypedSuperTokenChainMap<string> = {
  celo: stagingDefaultBufferCap,
  optimism: stagingDefaultBufferCap,
  base: stagingDefaultBufferCap,
  unichain: stagingDefaultBufferCap,
  ink: stagingDefaultBufferCap,
  soneium: stagingDefaultBufferCap,
  mode: stagingDefaultBufferCap,
  fraxtal: stagingDefaultBufferCap,
  superseed: stagingDefaultBufferCap,
  lisk: stagingDefaultBufferCap,
  worldchain: stagingDefaultBufferCap,
};
const stagingDefaultRateLimitPerSecond = '120000000';
const stagingRateLimitByChain: TypedSuperTokenChainMap<string> = {
  celo: stagingDefaultRateLimitPerSecond,
  optimism: stagingDefaultRateLimitPerSecond,
  base: stagingDefaultRateLimitPerSecond,
  unichain: stagingDefaultRateLimitPerSecond,
  ink: stagingDefaultRateLimitPerSecond,
  soneium: stagingDefaultRateLimitPerSecond,
  mode: stagingDefaultRateLimitPerSecond,
  fraxtal: stagingDefaultRateLimitPerSecond,
  superseed: stagingDefaultRateLimitPerSecond,
  lisk: stagingDefaultRateLimitPerSecond,
  worldchain: stagingDefaultRateLimitPerSecond,
};

const ownerAddress = '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba';
const stagingOwnerByChain: TypedSuperTokenChainMap<string> = {
  celo: ownerAddress,
  optimism: ownerAddress,
  base: ownerAddress,
  unichain: ownerAddress,
  ink: ownerAddress,
  soneium: ownerAddress,
  mode: ownerAddress,
  fraxtal: ownerAddress,
  superseed: ownerAddress,
  lisk: ownerAddress,
  worldchain: ownerAddress,
};
const stagingAmountRoutingThreshold = 5;
const stagingXERC20LockboxAddress =
  '0x44eca3a9B45e80F30cAb25bA16a5bF36591c7D29';
const stagingXERC20TokenAddress = '0xb0eb0856DD9A2DadBF170637A59f9eE2ca4A3f4a';
const stagingXERC20AddressesByChain: TypedSuperTokenChainMap<Address> = {
  celo: stagingXERC20LockboxAddress,
  optimism: stagingXERC20TokenAddress,
  base: stagingXERC20TokenAddress,
  unichain: stagingXERC20TokenAddress,
  ink: stagingXERC20TokenAddress,
  soneium: stagingXERC20TokenAddress,
  mode: stagingXERC20TokenAddress,
  fraxtal: stagingXERC20TokenAddress,
  superseed: stagingXERC20TokenAddress,
  lisk: stagingXERC20TokenAddress,
  worldchain: stagingXERC20TokenAddress,
};

const stagingExtraLockboxLimits: XERC20LimitConfig = {
  bufferCap: stagingDefaultBufferCap,
  rateLimitPerSecond: stagingDefaultRateLimitPerSecond,
};

const stagingExtraLockboxes = {
  base: [
    {
      // usdt
      lockbox: '0xd28ca33022d41758bed4f1a31a99dde8fc4d89b3',
      limits: stagingExtraLockboxLimits,
    },
    {
      // usdc
      lockbox: '0x50df545016d26735daacbbf5afda56dc17d8748b',
      limits: stagingExtraLockboxLimits,
    },
  ],
  optimism: [
    {
      // usdc
      lockbox: '0x18c4cdc2d774c047eac8375bb09853c4d6d6df36',
      limits: stagingExtraLockboxLimits,
    },
    {
      // usdt
      lockbox: '0x07e437d73e9e43ceece6ea14085b26159e3f7f31',
      limits: stagingExtraLockboxLimits,
    },
  ],
};

function isCCIPChain(chain: SuperTokenChainName): boolean {
  return supportedCCIPChains.includes(chain);
}

function generateIsmConfig(
  destination: SuperTokenChainName,
  ownerByChain: ChainMap<Address>,
  amountRoutingThreshold: number,
): IsmConfig {
  const defaultIsm = {
    type: IsmType.FALLBACK_ROUTING,
    domains: {},
    owner: ownerByChain[destination],
  };

  const entries = !isCCIPChain(destination)
    ? []
    : deploymentChains
        .filter((chain) => chain !== destination && isCCIPChain(chain))
        .map((origin) => [
          origin,
          {
            type: IsmType.AMOUNT_ROUTING,
            threshold: amountRoutingThreshold,
            lowerIsm: defaultIsm,
            upperIsm: {
              type: IsmType.CCIP,
              originChain: origin,
            },
          },
        ]);

  return {
    type: IsmType.AGGREGATION,
    threshold: 2,
    modules: [
      {
        type: IsmType.FALLBACK_ROUTING,
        domains: Object.fromEntries(entries),
        owner: ownerByChain[destination],
      },
      {
        type: IsmType.PAUSABLE,
        owner: ownerByChain[destination],
        paused: false,
      },
    ],
  };
}

function generateHookConfig(
  origin: SuperTokenChainName,
  ownerByChain: ChainMap<Address>,
  amountRoutingThreshold: number,
): HookConfig {
  if (!isCCIPChain(origin)) {
    return ethers.constants.AddressZero;
  }

  const entries = deploymentChains
    .filter((chain) => chain !== origin)
    .filter((destination) => isCCIPChain(destination))
    .map((destination) => [
      destination,
      {
        type: HookType.AMOUNT_ROUTING,
        lowerHook: {
          type: HookType.MAILBOX_DEFAULT,
        },
        threshold: amountRoutingThreshold,
        upperHook: {
          type: HookType.AGGREGATION,
          hooks: [
            {
              type: HookType.MAILBOX_DEFAULT,
            },
            {
              type: HookType.CCIP,
              destinationChain: destination,
            },
          ],
        },
      },
    ]);

  return {
    type: HookType.FALLBACK_ROUTING,
    domains: Object.fromEntries(entries),
    owner: ownerByChain[origin],
    fallback: {
      type: HookType.MAILBOX_DEFAULT,
    },
  };
}

function generateSuperTokenConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  ownerByChain: ChainMap<Address>,
  xERC20AddressesByChain: ChainMap<Address>,
  amountRoutingThreshold: number,
  bufferCapPerChain: ChainMap<string>,
  rateLimitPerSecondPerChain: ChainMap<string>,
  extraLockboxes?: ChainMap<{ lockbox: Address; limits: XERC20LimitConfig }[]>,
  ownerOverridesByChain?: ChainMap<Record<string, string>>,
): ChainMap<HypTokenRouterConfig> {
  return Object.fromEntries(
    deploymentChains.map((chain) => [
      chain,
      {
        ...routerConfig[chain],
        owner: ownerByChain[chain],
        type:
          chain === xERC20LockboxChain
            ? TokenType.XERC20Lockbox
            : TokenType.XERC20,
        token: xERC20AddressesByChain[chain],
        xERC20: {
          warpRouteLimits: {
            rateLimitPerSecond: rateLimitPerSecondPerChain[chain],
            bufferCap: bufferCapPerChain[chain],
          },
          extraBridges: extraLockboxes ? extraLockboxes[chain] : undefined,
        },
        // The ISM configuration uses a fallback routing ISM that routes messages based on amount thresholds:
        // - Below threshold: Uses default ISM
        // - Above threshold: Uses CCIP ISM for secure cross-chain messaging
        // This provides flexibility to use different ISMs based on transfer amounts
        // If an origin chain is not CCIP enabled, then we use the default ISM
        interchainSecurityModule: generateIsmConfig(
          chain,
          ownerByChain,
          amountRoutingThreshold,
        ),
        // The hook configuration uses an aggregation hook that combines:
        // 1. A mailbox default hook for basic message passing
        // 2. A fallback routing hook that routes messages based on amount thresholds:
        //    - Below threshold: Uses mailbox default hook
        //    - Above threshold: Uses CCIP hook for secure cross-chain messaging
        // This provides flexibility to use different hooks based on transfer amounts
        // If a destination chain is not CCIP enabled, then we use the default hook
        hook: generateHookConfig(chain, ownerByChain, amountRoutingThreshold),
        // This is used to explicitly check the owners of each key (e.g. collateralProxyAdmin).
        ownerOverrides: ownerOverridesByChain?.[chain] ?? undefined,
      },
    ]),
  );
}

// ref: https://www.notion.so/hyperlanexyz/Cross-chain-USDT-1926d35200d6804bbdb1dfd2042e1f19?pvs=4#1936d35200d680af9c05f6133d7bb9f7
export const getSuperTokenStagingWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  return generateSuperTokenConfig(
    routerConfig,
    stagingOwnerByChain,
    stagingXERC20AddressesByChain,
    stagingAmountRoutingThreshold,
    stagingBufferCapByChain,
    stagingRateLimitByChain,
    stagingExtraLockboxes,
  );
};

export const getSuperTokenProductionWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  return generateSuperTokenConfig(
    routerConfig,
    productionOwnerByChain,
    productionXERC20AddressesByChain,
    productionAmountRoutingThreshold,
    productionBufferCapByChain,
    productionRateLimitByChain,
    productionExtraLockboxes,
    productionOwnerOverridesByChain,
  );
};
