import { ChainMap } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

// Most chains use ICAs for warp fees. Chains listed here use Safes instead.
export const warpFeesSafes: ChainMap<Address> = {
  ethereum: '0x8Ff4c563f26db00e65bD93d9f662A51c304C09b0',

  // Jan 29, 2026 - Migrating Viction to Safes
  // ----------------------------------------------------------
  viction: '0xdE008b9E50C20a59f407CE92A27b1578ef14933D',

  // Mar 12, 2026 - Igra Chain Deployment
  // ----------------------------------------------------------
  // igra: '0xF4edD65e85122E50cb22A45c10FcA082F8a72396',
};
