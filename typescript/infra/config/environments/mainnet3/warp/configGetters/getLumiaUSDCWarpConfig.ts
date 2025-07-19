import {
  ChainMap,
  HypTokenRouterConfig,
  SubmitterMetadata,
  TokenType,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';
import { assert, objMap } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { getRegistry } from '../../../../registry.js';
import { usdcTokenAddresses } from '../cctp.js';
import { WarpRouteIds } from '../warpIds.js';

const FIAT_COLLATERAL_CHAIN = 'lumiaprism';
const FIAT_TOKEN = '0xFF297AC2CB0a236155605EB37cB55cFCAe6D3F01';

const REBALANCER = '0xa3948a15e1d0778a7d53268b651B2411AF198FE3';

const owners = {
  ethereum: '0x18da35630c84fCD9d9c947fC61cA7a6d9b841577',
  lumiaprism: '0xa86C4AF592ddAa676f53De278dE9cfCD52Ae6B39',
  arbitrum: '0xc8A9Dea7359Bd6FDCAD3B8EDE108416C25cF4CE9',
  base: '0xcEC53d6fF9B4C7b8E77f0C0D3f8828Bb872f2377',
  optimism: '0x914931eBb5638108651455F50C1F784d3E5fd3EC',
} as const;

const EXISTING_CHAINS = ['ethereum', 'lumiaprism'];

const submitterConfig = objMap(
  owners,
  (chain, owner): { submitter: SubmitterMetadata } => {
    if (!EXISTING_CHAINS.includes(chain)) {
      return {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain,
        },
      };
    }

    return {
      submitter: {
        safeAddress: owner,
        version: '1.0',
        type: TxSubmitterType.GNOSIS_TX_BUILDER,
        chain,
      },
    };
  },
);

console.log(JSON.stringify(submitterConfig, null, 2));

export const getLumiaUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const registry = getRegistry();
  const mainnetCCTP = registry.getWarpRoute(WarpRouteIds.MainnetCCTP);

  assert(mainnetCCTP, 'MainnetCCTP warp route not found');

  const cctpBridges = Object.fromEntries(
    mainnetCCTP.tokens.map(({ chainName, addressOrDenom }) => [
      chainName,
      addressOrDenom!,
    ]),
  );

  return objMap(owners, (chain, owner): HypTokenRouterConfig => {
    if (chain === FIAT_COLLATERAL_CHAIN) {
      return {
        ...routerConfig[chain],
        type: TokenType.collateralFiat,
        token: FIAT_TOKEN,
        owner,
      };
    }

    const cctpBridge = cctpBridges[chain];
    const remotes = Object.keys(owners).filter(
      (c) => c !== chain && c !== FIAT_COLLATERAL_CHAIN,
    );

    const allowedRebalancingBridges = Object.fromEntries(
      remotes.map((remote) => [remote, [{ bridge: cctpBridge }]]),
    );

    const config: HypTokenRouterConfig = {
      ...routerConfig[chain],
      type: TokenType.collateral,
      token: usdcTokenAddresses[chain],
      owner,
      contractVersion: '8.0.0',
      allowedRebalancers: [REBALANCER],
      allowedRebalancingBridges,
    };

    return config;
  });
};
