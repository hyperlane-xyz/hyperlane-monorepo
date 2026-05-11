import {
  ChainMap,
  ChainName,
  DEFAULT_ROUTER_KEY,
  HypTokenRouterConfig,
  TokenFeeConfigInput,
  TokenFeeType,
  TokenType,
} from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { WarpRouteIds } from '../warpIds.js';
import { getRebalancingBridgesConfigFor } from './utils.js';

const MOONPAY_OWNER = '0x1cFd6A81e98de59e3eeB3AE35c3cb13FCb586E1E';
const QUOTE_SIGNERS = [
  '0xEd1829805De615eEFC7303766D395Ea0a1B2b04d',
  '0x6bb7818bbE8d88094Cf3620e58BC6BbEd542B867',
];

const ROUTE_CHAINS = [
  'solanamainnet',
  'arbitrum',
  'base',
  'ethereum',
] as const satisfies readonly ChainName[];

const EVM_CHAINS = ['arbitrum', 'base', 'ethereum'] as const;

const HOOKS = {
  arbitrum: '0xA5bD573fC00A2683F108b8F04220ca530321436c',
  base: '0xa17f241a706e4a28f87136FCF999FAdc4b7c7429',
  ethereum: '0x0383358bc735fFA9ba91592305932f69CA01927b',
} as const;

const ISMS = {
  arbitrum: '0x557493e042bb56E0417F963C47c48c5Ec37e1ac2',
  base: '0x48381CE8eCd58aB3f9278931045D68F08981fc5c',
  ethereum: '0xA566c3993eefC9c0aA3Ce44220208f8438133eE8',
} as const;

function buildCrossCollateralRoutingFee(
  owner: string,
  destinations: readonly ChainName[],
): TokenFeeConfigInput {
  return {
    type: TokenFeeType.CrossCollateralRoutingFee,
    owner,
    feeContracts: Object.fromEntries(
      destinations.map((dest) => [
        dest,
        {
          [DEFAULT_ROUTER_KEY]: {
            type: TokenFeeType.OffchainQuotedLinearFee,
            owner,
            bps: 3,
            quoteSigners: QUOTE_SIGNERS,
          },
        },
      ]),
    ),
  };
}

export async function getUSDTCitreaMoonpayWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<{ owner: string }>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  const oftRebalancingConfigByChain = getRebalancingBridgesConfigFor(
    EVM_CHAINS,
    [WarpRouteIds.USDTOft],
  );

  return {
    arbitrum: {
      type: TokenType.crossCollateral,
      token: tokens.arbitrum.USDT,
      mailbox: routerConfig.arbitrum.mailbox,
      owner: MOONPAY_OWNER,
      ...oftRebalancingConfigByChain.arbitrum,
      hook: HOOKS.arbitrum,
      interchainSecurityModule: ISMS.arbitrum,
      tokenFee: buildCrossCollateralRoutingFee(MOONPAY_OWNER, ROUTE_CHAINS),
    },
    base: {
      type: TokenType.crossCollateral,
      token: tokens.base.USDT,
      mailbox: routerConfig.base.mailbox,
      owner: MOONPAY_OWNER,
      hook: HOOKS.base,
      interchainSecurityModule: ISMS.base,
      tokenFee: buildCrossCollateralRoutingFee(MOONPAY_OWNER, ROUTE_CHAINS),
    },
    ethereum: {
      type: TokenType.crossCollateral,
      token: tokens.ethereum.USDT,
      mailbox: routerConfig.ethereum.mailbox,
      owner: MOONPAY_OWNER,
      ...oftRebalancingConfigByChain.ethereum,
      remoteRouters: {
        8453: { address: '0x7abBb4ea8a5895127500CF0C15830C9Eb9f61F96' },
        42161: { address: '0x75a9297db5F0349fd1d6f4030953Fe17175e06d4' },
      },
      hook: HOOKS.ethereum,
      interchainSecurityModule: ISMS.ethereum,
      tokenFee: buildCrossCollateralRoutingFee(MOONPAY_OWNER, ROUTE_CHAINS),
    },
  };
}
