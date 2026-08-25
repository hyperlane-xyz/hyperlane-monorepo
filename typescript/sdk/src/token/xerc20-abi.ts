import { getAbiItem, toEventSelector } from 'viem';

/**
 * Minimal ABI for parsing ConfigurationChanged events from Velodrome XERC20.
 * Shared between EvmXERC20Reader and xerc20 utilities.
 */
export const XERC20_VS_ABI = [
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'bridge',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint112',
        name: 'bufferCap',
        type: 'uint112',
      },
      {
        indexed: false,
        internalType: 'uint128',
        name: 'rateLimitPerSecond',
        type: 'uint128',
      },
    ],
    name: 'ConfigurationChanged',
    type: 'event',
  },
] as const;

export const CONFIGURATION_CHANGED_EVENT_SELECTOR = toEventSelector(
  getAbiItem({
    abi: XERC20_VS_ABI,
    name: 'ConfigurationChanged',
  }),
);

/**
 * Minimal ABI for the event a Standard XERC20 emits when a bridge's limits are
 * set. The bridge is the only indexed parameter, so a log carries it in
 * topics[1] whichever implementation emitted it.
 *
 * Not the `BridgeLimitsSet(address,uint256)` that IXERC20VS.sol declares: the
 * deployed Standard tokens emit this three-parameter form, and querying the
 * other signature's topic returns nothing.
 */
export const XERC20_STANDARD_ABI = [
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: 'uint256',
        name: '_mintingLimit',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: '_burningLimit',
        type: 'uint256',
      },
      {
        indexed: true,
        internalType: 'address',
        name: '_bridge',
        type: 'address',
      },
    ],
    name: 'BridgeLimitsSet',
    type: 'event',
  },
] as const;

export const BRIDGE_LIMITS_SET_EVENT_SELECTOR = toEventSelector(
  getAbiItem({
    abi: XERC20_STANDARD_ABI,
    name: 'BridgeLimitsSet',
  }),
);
