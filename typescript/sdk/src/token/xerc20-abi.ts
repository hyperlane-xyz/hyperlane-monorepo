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
