import {
  getAbiItem,
  parseAbi,
  toEventSelector,
  toFunctionSelector,
} from 'viem';

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

/**
 * Minimal ABI for the mint authority and cap an Aevo token holds for each
 * minter, and for its owner. Aevo tokens expose neither `setLimits` nor
 * `setBufferCap`, so this is how a router is approved to mint and capped.
 *
 * Derived from the deployed bytecode, as the source is not published.
 * `authorities` answers a single bool word and `caps` a single uint256 word.
 * `setOwner` hands the token to a new owner in one step: there is no pending
 * owner to accept it, so an address that cannot act as owner is final.
 */
export const XERC20_AEVO_ABI = parseAbi([
  'function authorities(address minter) view returns (bool)',
  'function caps(address minter) view returns (uint256)',
  'function updateAuthority(address minter, bool authorized)',
  'function setCap(address minter, uint256 cap)',
  'function owner() view returns (address)',
  'function setOwner(address newOwner)',
]);

/**
 * The selector of the getter that answers what a minter has minted and not
 * burned, which is what the token compares a mint to the cap with and a burn to.
 * The source of the token is not published, so it is known by its selector
 * alone, and it is not among the selectors that identify an Aevo token. It
 * answers the mapping the token keeps at storage slot 11, a single uint256 word.
 */
export const AEVO_OUTSTANDING_SELECTOR = '0x963aee20';

/**
 * The selectors that identify an Aevo token: every one of them is part of the
 * limit surface the SDK reads and writes, so a token carrying all four can be
 * managed and one missing any cannot. The owner functions are not among them.
 */
export const AEVO_XERC20_SELECTORS = [
  toFunctionSelector(getAbiItem({ abi: XERC20_AEVO_ABI, name: 'authorities' })),
  toFunctionSelector(getAbiItem({ abi: XERC20_AEVO_ABI, name: 'caps' })),
  toFunctionSelector(
    getAbiItem({ abi: XERC20_AEVO_ABI, name: 'updateAuthority' }),
  ),
  toFunctionSelector(getAbiItem({ abi: XERC20_AEVO_ABI, name: 'setCap' })),
];
