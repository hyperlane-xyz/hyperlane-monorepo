import { TokenFeeType } from '@hyperlane-xyz/sdk';

import { getWarpFeeOwner } from '../../governance/utils.js';
import { usdcTokenAddresses } from '../cctp.js';

const evmChains = [
  'ethereum',
  'arbitrum',
  'base',
  'optimism',
  'polygon',
  'unichain',
] as const;

const owner = '0x3e0A78A330F2b97059A4D507ca9d8292b65B6FB5' as const;

export function getEclipseUSDCTransferRouterConfig() {
  return Object.fromEntries(
    evmChains.map((chain) => [
      chain,
      {
        token: usdcTokenAddresses[chain],
        owner,
        fee: {
          type: TokenFeeType.LinearFee,
          owner: getWarpFeeOwner(chain),
          bps: 5n,
        },
      },
    ]),
  );
}
