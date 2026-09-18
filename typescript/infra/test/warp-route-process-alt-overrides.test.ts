import { expect } from 'chai';

import { TokenStandard, type WarpCoreConfig } from '@hyperlane-xyz/sdk';
import { addressToBytes32 } from '@hyperlane-xyz/utils';

import { buildWarpRouteProcessAltOverrides } from '../src/config/agent/relayer.js';

describe('buildWarpRouteProcessAltOverrides', () => {
  const solanaProgram = '4U8M7W9hMZGK7pLyxNxnS2vvK5r2rM2C69EQ3xEiTKFV';
  const coreAlt = '5iPyGCTQ2xHaCxv9A8GDJzt2tHWL8t9FK8UwG3KoQsYo';
  const warpAltA = '8MedWKtfT7QdMcZWDuVPx1iUrJRRZXDQpzyZAaqzQg2Z';
  const warpAltB = '4zybokQ8gLLPWUawXaw1JhrPZZsTaTGeaHZhLLb5nPhS';

  function routeWithAlts(): WarpCoreConfig {
    return {
      tokens: [
        {
          chainName: 'solanamainnet',
          standard: TokenStandard.SealevelHypCollateral,
          decimals: 6,
          symbol: 'USDC',
          name: 'USD Coin',
          addressOrDenom: solanaProgram,
        },
      ],
      options: {
        sealevel: {
          altAddresses: {
            solanamainnet: {
              core: coreAlt,
              warpSpecific: [warpAltA, warpAltB],
            },
          },
        },
      },
    };
  }

  it('emits the complete ordered ALT bundle for the destination program', () => {
    const result = buildWarpRouteProcessAltOverrides([routeWithAlts()]);

    expect(result.solanamainnet).to.deep.equal([
      {
        matchingList: [{ recipientAddress: addressToBytes32(solanaProgram) }],
        addressLookupTables: [coreAlt, warpAltA, warpAltB],
      },
    ]);
  });

  it('ignores routes without registered Sealevel ALTs', () => {
    const route = routeWithAlts();
    delete route.options;

    expect(buildWarpRouteProcessAltOverrides([route])).to.deep.equal({});
  });

  it('rejects inconsistent ALT metadata instead of silently omitting it', () => {
    const route = routeWithAlts();
    route.tokens = [];

    expect(() => buildWarpRouteProcessAltOverrides([route])).to.throw(
      'Warp ALT metadata references missing token on solanamainnet',
    );
  });
});
