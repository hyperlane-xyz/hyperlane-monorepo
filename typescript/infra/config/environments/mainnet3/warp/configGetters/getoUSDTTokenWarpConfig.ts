import { ethers } from 'ethers';

import {
  ChainMap,
  HookConfig,
  HookType,
  HypTokenRouterConfig,
  IsmConfig,
  IsmType,
  TokenFeeConfigInput,
  TokenFeeType,
  TokenType,
  XERC20TokenExtraBridgesLimits,
  XERC20Type,
  XERC20VSLimitConfig,
} from '@hyperlane-xyz/sdk';
import { Address, assert } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { getFixedRoutingFeeConfig } from './utils.js';
import { warpFeesIcas } from '../../governance/ica/warpFees.js';
import { warpFeesSafes } from '../../governance/safe/warpFees.js';
import { awTimelocks } from '../../governance/timelock/aw.js';
import { DEPLOYER } from '../../owners.js';

// Environment-independent configuration
export const deploymentChains = [
  // Collateral (XERC20Lockbox)
  'ethereum',
  'celo',
  // Synthetic superswap (XERC20)
  'optimism',
  'base',
  'unichain',
  'ink',
  'soneium',
  'mode',
  'fraxtal',
  'lisk',
  'metal',
  'bob',
  'zerogravity',
  // Aug 6, 2026 - oUSDT expansion (new xERC20 legs, 6 decimals)
  'tron',
  'bsc',
  'arbitrum',
  'tea',
] as const;
const supportedCCIPChains = ['base', 'mode', 'optimism'];

// Router implementation version to upgrade to. Deployed staging routers are on
// core 6.1.0, which predates FungibleTokenRouter fee support; setting this makes
// `warp apply` upgrade the proxy impl to the current @hyperlane-xyz/core release
// (via ProxyAdmin.upgrade) so setFeeRecipient/feeRecipient exist for the OQLF fee.
const contractVersion = '12.0.0';
const xERC20LockboxChains: oUSDTTokenChainName[] = ['celo', 'ethereum'];

type oUSDTTokenChainName = (typeof deploymentChains)[number];
type TypedoUSDTTokenChainMap<T> = {
  [Key in oUSDTTokenChainName]: T;
};

// Fee configuration
// 5 bps OffchainQuotedLinearFee withdrawal fee on collateral + new-chain legs.
// No fee on the existing synthetic superswap legs.
const withdrawalFeeBps = 5;
const feeChains: oUSDTTokenChainName[] = [
  'ethereum',
  'celo',
  'tron',
  'bsc',
  'arbitrum',
  'tea',
];
// In-code quote signers (hyperlane-mainnet3-key-quotesigner GCP secret).
const stagingQuoteSigners: Address[] = [
  DEPLOYER,
  '0xEd1829805De615eEFC7303766D395Ea0a1B2b04d',
];
const productionQuoteSigners: Address[] = [
  '0xEd1829805De615eEFC7303766D395Ea0a1B2b04d',
];
const stagingFeeOwnerByChain: ChainMap<Address> = Object.fromEntries(
  feeChains.map((chain) => [chain, DEPLOYER]),
);
const productionFeeOwnerByChain: ChainMap<Address> = {
  ethereum: warpFeesSafes.ethereum,
  celo: warpFeesIcas.celo,
  tron: warpFeesIcas.tron,
  bsc: warpFeesIcas.bsc,
  arbitrum: warpFeesIcas.arbitrum,
  tea: warpFeesIcas.tea,
};

// Environment-specific configuration

// Production
const upperBufferCap = '20000000000000'; // 20M = 20 * 10^6 ^ 10^6
const middleBufferCap = '8000000000000'; // 8M = 8 * 10^6 ^ 10^6
const lowerBufferCap = '2000000000000'; // 2M = 2 * 10^6 ^ 10^6
const productionBufferCapByChain: TypedoUSDTTokenChainMap<string> = {
  ethereum: upperBufferCap,
  celo: upperBufferCap,
  optimism: upperBufferCap,
  base: upperBufferCap,
  unichain: upperBufferCap,
  ink: middleBufferCap,
  soneium: lowerBufferCap,
  mode: lowerBufferCap,
  fraxtal: lowerBufferCap,
  lisk: lowerBufferCap,
  metal: lowerBufferCap,
  bob: lowerBufferCap,
  zerogravity: middleBufferCap,
  tron: upperBufferCap,
  bsc: upperBufferCap,
  arbitrum: upperBufferCap,
  tea: lowerBufferCap,
};
const productionDefaultRateLimitPerSecond = '5000000000'; // 5k/s = 5 * 10^3 ^ 10^6
const middleRateLimitPerSecond = '2000000000'; // 2k/s = 2 * 10^3 ^ 10^6
const lowerRateLimitPerSecond = '500000000'; // 0.5k/s = 0.5 * 10^3 ^ 10^6
const productionRateLimitByChain: TypedoUSDTTokenChainMap<string> = {
  ethereum: productionDefaultRateLimitPerSecond,
  celo: productionDefaultRateLimitPerSecond,
  optimism: productionDefaultRateLimitPerSecond,
  base: productionDefaultRateLimitPerSecond,
  unichain: productionDefaultRateLimitPerSecond,
  ink: middleRateLimitPerSecond,
  soneium: lowerRateLimitPerSecond,
  mode: lowerRateLimitPerSecond,
  fraxtal: lowerRateLimitPerSecond,
  lisk: lowerRateLimitPerSecond,
  metal: lowerRateLimitPerSecond,
  bob: lowerRateLimitPerSecond,
  zerogravity: middleRateLimitPerSecond,
  tron: productionDefaultRateLimitPerSecond,
  bsc: productionDefaultRateLimitPerSecond,
  arbitrum: productionDefaultRateLimitPerSecond,
  tea: lowerRateLimitPerSecond,
};

const DPL_OWNED_CHAINS: oUSDTTokenChainName[] = [];
const productionOwnerByChain: TypedoUSDTTokenChainMap<string> =
  deploymentChains.reduce((acc, chain) => {
    if (DPL_OWNED_CHAINS.includes(chain as oUSDTTokenChainName)) {
      acc[chain] = DEPLOYER;
    } else {
      const timelock = awTimelocks[chain];
      assert(timelock, `Timelock for ${chain} not found`);
      acc[chain] = timelock;
    }
    return acc;
  }, {} as TypedoUSDTTokenChainMap<string>);

const productionOwnerOverridesByChain: TypedoUSDTTokenChainMap<
  Record<'collateralToken' | 'collateralProxyAdmin', string>
> = deploymentChains.reduce(
  (acc, chain) => {
    acc[chain] = {
      collateralToken: productionOwnerByChain[chain],
      collateralProxyAdmin: productionOwnerByChain[chain],
    };
    return acc;
  },
  {} as TypedoUSDTTokenChainMap<
    Record<'collateralToken' | 'collateralProxyAdmin', string>
  >,
);

const productionAmountRoutingThreshold = 250000000000; // 250k = 250 * 10^3 ^ 10^6
const productionEthereumXERC20LockboxAddress =
  '0x6D265C7dD8d76F25155F1a7687C693FDC1220D12';
const productionCeloXERC20LockboxAddress =
  '0x5e5F4d6B03db16E7f00dE7C9AFAA53b92C8d1D42';
const productionXERC20TokenAddress =
  '0x1217BfE6c773EEC6cc4A38b5Dc45B92292B6E189';
// Production Tron xERC20 (already deployed; non-deterministic on Tron).
// TUtpibSKKE43FQNzw2794pcHqDsYsUTKPa in base58; kept as EVM hex to match the
// rest of this file and the tron chain addresses in the registry.
const productionTronXERC20Address =
  '0xcf961fD920a2f49E46dcF78812a5a9De35972748';

const zeroLimits: XERC20VSLimitConfig = {
  type: XERC20Type.Velo,
  bufferCap: '0',
  rateLimitPerSecond: '0',
};

const productionCCIPTokenPoolAddresses: ChainMap<Address> = {
  ethereum: '0xa3532633401AbFfbd15e6be825a45FB7F141469B',
  celo: '0x47Db76c9c97F4bcFd54D8872FDb848Cab696092d',
  base: '0xa760D20a91C076A57b270D3F7a3150421ab40591',
  optimism: '0x6a21a19aD44542d83F7f7FF45Aa31A62a36200de',
  bob: '0xAFEd606Bd2CAb6983fC6F10167c98aaC2173D77f',
  zerogravity: '0xd7502CaBdb70c79382deF58FB6df3CdA69cb2A1b',
};

const productionCCIPTokenPoolLimits: XERC20VSLimitConfig = {
  type: XERC20Type.Velo,
  bufferCap: upperBufferCap,
  rateLimitPerSecond: productionDefaultRateLimitPerSecond,
};

const productionExtraBridges: ChainMap<XERC20TokenExtraBridgesLimits[]> = {
  ethereum: [
    {
      lockbox: productionEthereumXERC20LockboxAddress,
      limits: {
        type: XERC20Type.Velo,
        bufferCap: productionBufferCapByChain.ethereum,
        rateLimitPerSecond: productionRateLimitByChain.ethereum,
      },
    },
    {
      lockbox: productionCCIPTokenPoolAddresses.ethereum,
      limits: productionCCIPTokenPoolLimits,
    },
  ],
  celo: [
    {
      lockbox: productionCCIPTokenPoolAddresses.celo,
      limits: productionCCIPTokenPoolLimits,
    },
  ],
  base: [
    {
      // usdt
      lockbox: '0x9d922c23d78179c2e75fe394fc8e49363f2dda85',
      limits: zeroLimits,
    },
    {
      // usdc
      lockbox: '0xe92e51d99ae33114c60d9621fb2e1ec0acea7e30',
      limits: zeroLimits,
    },
    {
      lockbox: productionCCIPTokenPoolAddresses.base,
      limits: productionCCIPTokenPoolLimits,
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
      limits: zeroLimits,
    },
    {
      lockbox: productionCCIPTokenPoolAddresses.optimism,
      limits: productionCCIPTokenPoolLimits,
    },
  ],
  bob: [
    {
      lockbox: productionCCIPTokenPoolAddresses.bob,
      limits: productionCCIPTokenPoolLimits,
    },
  ],
  zerogravity: [
    {
      lockbox: productionCCIPTokenPoolAddresses.zerogravity,
      limits: productionCCIPTokenPoolLimits,
    },
  ],
};

const productionXERC20AddressesByChain: TypedoUSDTTokenChainMap<Address> = {
  ethereum: productionEthereumXERC20LockboxAddress,
  celo: productionCeloXERC20LockboxAddress,
  optimism: productionXERC20TokenAddress,
  base: productionXERC20TokenAddress,
  unichain: productionXERC20TokenAddress,
  ink: productionXERC20TokenAddress,
  soneium: productionXERC20TokenAddress,
  mode: productionXERC20TokenAddress,
  fraxtal: productionXERC20TokenAddress,
  lisk: productionXERC20TokenAddress,
  metal: productionXERC20TokenAddress,
  bob: productionXERC20TokenAddress,
  zerogravity: productionXERC20TokenAddress,
  tron: productionTronXERC20Address,
  bsc: productionXERC20TokenAddress,
  arbitrum: productionXERC20TokenAddress,
  tea: productionXERC20TokenAddress,
};

// Staging
const stagingDefaultBufferCap = '25000000000';
const stagingBufferCapByChain: TypedoUSDTTokenChainMap<string> =
  deploymentChains.reduce((acc, chain) => {
    acc[chain] = stagingDefaultBufferCap;
    return acc;
  }, {} as TypedoUSDTTokenChainMap<string>);
const stagingDefaultRateLimitPerSecond = '120000000';
const stagingRateLimitByChain: TypedoUSDTTokenChainMap<string> =
  deploymentChains.reduce((acc, chain) => {
    acc[chain] = stagingDefaultRateLimitPerSecond;
    return acc;
  }, {} as TypedoUSDTTokenChainMap<string>);

const stagingOwnerByChain: TypedoUSDTTokenChainMap<string> =
  deploymentChains.reduce((acc, chain) => {
    acc[chain] = DEPLOYER;
    return acc;
  }, {} as TypedoUSDTTokenChainMap<string>);

const stagingAmountRoutingThreshold = 5;
const stagingEthereumXERC20LockboxAddress =
  '0x935EAaAb78B491Cd9281f438E413767893913983';
const stagingCeloXERC20LockboxAddress =
  '0x9a3D8d7E931679374448FB2B661F664D42d05057';
const stagingXERC20TokenAddress = '0x0290B74980C051EB46b84b1236645444e77da0E9';
// Staging Tron xERC20 (already deployed; non-deterministic on Tron).
// TUVzhcYfWwAp3qGdgTFDKa7cePLvurvxdA in base58; kept as EVM hex to match the
// rest of this file and the tron chain addresses in the registry.
const stagingTronXERC20Address = '0xcB44E40813b21C64BAacB1bC9B9A2272320a22E2';
const stagingXERC20AddressesByChain: TypedoUSDTTokenChainMap<Address> = {
  ethereum: stagingEthereumXERC20LockboxAddress,
  celo: stagingCeloXERC20LockboxAddress,
  optimism: stagingXERC20TokenAddress,
  base: stagingXERC20TokenAddress,
  unichain: stagingXERC20TokenAddress,
  ink: stagingXERC20TokenAddress,
  soneium: stagingXERC20TokenAddress,
  mode: stagingXERC20TokenAddress,
  fraxtal: stagingXERC20TokenAddress,
  lisk: stagingXERC20TokenAddress,
  metal: stagingXERC20TokenAddress,
  bob: stagingXERC20TokenAddress,
  zerogravity: stagingXERC20TokenAddress,
  tron: stagingTronXERC20Address,
  bsc: stagingXERC20TokenAddress,
  arbitrum: stagingXERC20TokenAddress,
  tea: stagingXERC20TokenAddress,
};

const stagingExtraBridges: ChainMap<XERC20TokenExtraBridgesLimits[]> = {
  ethereum: [
    {
      lockbox: stagingEthereumXERC20LockboxAddress,
      limits: {
        type: XERC20Type.Velo,
        bufferCap: stagingBufferCapByChain.ethereum,
        rateLimitPerSecond: stagingRateLimitByChain.ethereum,
      },
    },
  ],
};

function isCCIPChain(chain: oUSDTTokenChainName): boolean {
  return supportedCCIPChains.includes(chain);
}

function generateTokenFeeConfig(
  chain: oUSDTTokenChainName,
  feeOwnerByChain: ChainMap<Address>,
  quoteSigners: Address[],
): TokenFeeConfigInput | undefined {
  if (!feeChains.includes(chain)) {
    return undefined;
  }
  const owner = feeOwnerByChain[chain];
  assert(owner, `Fee owner for ${chain} not found`);
  // Tron: a per-destination RoutingFee would deploy one OQLF per destination,
  // which is prohibitively expensive on TVM. Use a single bare OQLF instead.
  if (chain === 'tron') {
    return {
      type: TokenFeeType.OffchainQuotedLinearFee,
      owner,
      bps: withdrawalFeeBps,
      quoteSigners,
    };
  }
  const feeDestinations = deploymentChains.filter(
    (destination) => destination !== chain,
  );
  return getFixedRoutingFeeConfig(
    owner,
    feeDestinations,
    withdrawalFeeBps,
    undefined,
    quoteSigners,
  );
}

function generateIsmConfig(
  destination: oUSDTTokenChainName,
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
  origin: oUSDTTokenChainName,
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

function generateoUSDTTokenConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  ownerByChain: ChainMap<Address>,
  xERC20AddressesByChain: ChainMap<Address>,
  amountRoutingThreshold: number,
  bufferCapPerChain: ChainMap<string>,
  rateLimitPerSecondPerChain: ChainMap<string>,
  feeOwnerByChain: ChainMap<Address>,
  quoteSigners: Address[],
  extraBridges?: ChainMap<XERC20TokenExtraBridgesLimits[]>,
  ownerOverridesByChain?: ChainMap<Record<string, string>>,
): ChainMap<HypTokenRouterConfig> {
  return Object.fromEntries(
    deploymentChains.map((chain) => [
      chain,
      {
        ...routerConfig[chain],
        owner: ownerByChain[chain],
        contractVersion,
        type: xERC20LockboxChains.includes(chain)
          ? TokenType.XERC20Lockbox
          : TokenType.XERC20,
        token: xERC20AddressesByChain[chain],
        xERC20: {
          warpRouteLimits: {
            type: XERC20Type.Velo,
            rateLimitPerSecond: rateLimitPerSecondPerChain[chain],
            bufferCap: bufferCapPerChain[chain],
          },
          extraBridges: extraBridges ? extraBridges[chain] : undefined,
        },
        // 5 bps OffchainQuotedLinearFee withdrawal fee on collateral + new legs;
        // undefined (no fee) on the synthetic superswap legs.
        tokenFee: generateTokenFeeConfig(chain, feeOwnerByChain, quoteSigners),
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
export const getoUSDTTokenStagingWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  return generateoUSDTTokenConfig(
    routerConfig,
    stagingOwnerByChain,
    stagingXERC20AddressesByChain,
    stagingAmountRoutingThreshold,
    stagingBufferCapByChain,
    stagingRateLimitByChain,
    stagingFeeOwnerByChain,
    stagingQuoteSigners,
    stagingExtraBridges,
  );
};

export const getoUSDTTokenProductionWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  return generateoUSDTTokenConfig(
    routerConfig,
    productionOwnerByChain,
    productionXERC20AddressesByChain,
    productionAmountRoutingThreshold,
    productionBufferCapByChain,
    productionRateLimitByChain,
    productionFeeOwnerByChain,
    productionQuoteSigners,
    productionExtraBridges,
    productionOwnerOverridesByChain,
  );
};
