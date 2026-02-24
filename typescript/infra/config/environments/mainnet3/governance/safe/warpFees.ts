import { ChainMap } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

// Only need the Ethereum Safe here.
// All other chains will use ICAs for warp fees.
export const warpFeesSafes: ChainMap<Address> = {
  ethereum: '0x8Ff4c563f26db00e65bD93d9f662A51c304C09b0',

  // Jan 29, 2026 - Migrating Viction to Safes
  // ----------------------------------------------------------
  viction: '0xdE008b9E50C20a59f407CE92A27b1578ef14933D',
};
