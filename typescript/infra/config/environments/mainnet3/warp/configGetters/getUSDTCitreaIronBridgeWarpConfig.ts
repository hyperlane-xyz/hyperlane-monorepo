import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { assert, addressToBytes32 } from '@hyperlane-xyz/utils';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { getRegistry } from '../../../../registry.js';
import { WarpRouteIds } from '../warpIds.js';

// Owner of every TokenBridgeDepositAddress instance.
const BRIDGE_OWNER = '0x1cFd6A81e98de59e3eeB3AE35c3cb13FCb586E1E';

// Iron-issued deposit addresses for the USDT ↔ ctUSD lane (ethereum ↔ citrea only).
// Mint   eth USDT  → citrea ctUSD  autoramp 019e0749-766f-7149-b1ed-e3904b9e2bbe
// Redeem citrea ctUSD → eth USDT   autoramp 019e0762-ea8e-72b3-a2ee-70eaa6faaa5f
// (Iron labels the redeem autoramp "USDC" — that is a typo on Iron's side.)
const IRON_DEPOSITS: Record<
  BridgeChain,
  Partial<Record<BridgeChain, string>>
> = {
  ethereum: { citrea: '0xe14741345326513ce753768d45e7c9ef34444931' },
  citrea: { ethereum: '0xd3d3a44be43ccdc3e3e1dac16649de242d165d43' },
};

const ORIGIN_TOKENS: Record<BridgeChain, string> = {
  ethereum: tokens.ethereum.USDT,
  citrea: tokens.citrea.ctUSD,
};

const BRIDGE_CHAINS = ['ethereum', 'citrea'] as const;
type BridgeChain = (typeof BRIDGE_CHAINS)[number];

// The recipient warp-route router on each destination chain:
//   ethereum: USDT/moonpay ethereum router (receives ctUSD redeem → releases USDT)
//   citrea:   CROSS/moonpay citrea router  (receives USDT mint   → releases ctUSD)
function getDestRecipientAddresses(): Record<BridgeChain, string> {
  const usdtMoonpay = getRegistry().getWarpRoute(
    WarpRouteIds.USDTCitreaMoonpay,
  );
  assert(usdtMoonpay, 'USDT/moonpay route not found in registry');
  const crossMoonpay = getRegistry().getWarpRoute(WarpRouteIds.CrossMoonpay);
  assert(crossMoonpay, 'CROSS/moonpay route not found in registry');

  const ethereumToken = usdtMoonpay.tokens.find(
    (t) => t.chainName === 'ethereum' && t.symbol === 'USDT',
  );
  assert(
    ethereumToken?.addressOrDenom,
    'Missing USDT/moonpay ethereum router in registry',
  );

  const citreaToken = crossMoonpay.tokens.find(
    (t) => t.chainName === 'citrea' && t.symbol === 'ctUSD',
  );
  assert(
    citreaToken?.addressOrDenom,
    'Missing CROSS/moonpay citrea router in registry',
  );

  return {
    ethereum: ethereumToken.addressOrDenom,
    citrea: citreaToken.addressOrDenom,
  };
}

function destinationConfigsFor(
  origin: BridgeChain,
  destRecipients: Record<BridgeChain, string>,
) {
  const lanes = IRON_DEPOSITS[origin];
  const result: Record<
    string,
    Record<string, { depositAddress: string; feeBps: string }>
  > = {};
  for (const dest of BRIDGE_CHAINS) {
    const depositAddress = lanes[dest];
    if (depositAddress === undefined) continue;
    result[dest] = {
      [addressToBytes32(destRecipients[dest])]: { depositAddress, feeBps: '0' },
    };
  }
  return result;
}

export const getUSDTCitreaIronBridgeWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const destRecipients = getDestRecipientAddresses();

  return Object.fromEntries(
    BRIDGE_CHAINS.map((origin) => {
      assert(routerConfig[origin], `Missing router config for ${origin}`);
      return [
        origin,
        {
          ...routerConfig[origin],
          type: TokenType.collateralDepositAddress,
          token: ORIGIN_TOKENS[origin],
          owner: BRIDGE_OWNER,
          destinationConfigs: destinationConfigsFor(origin, destRecipients),
        },
      ];
    }),
  );
};
