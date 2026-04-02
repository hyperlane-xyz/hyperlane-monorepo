import { tokens } from '../../../../src/config/warp.js';

export const usdtTokenAddresses = {
  ethereum: tokens.ethereum.USDT,
  bsc: tokens.bsc.USDT,
  arbitrum: tokens.arbitrum.USDT,
  plasma: tokens.plasma.USDT,
  tron: tokens.tron.USDT,
  solanamainnet: tokens.solanamainnet.USDT,
} as const;
