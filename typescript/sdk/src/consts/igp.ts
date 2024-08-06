import { ethers } from 'ethers';

export const TOKEN_EXCHANGE_RATE_DECIMALS = 10;

export const TOKEN_EXCHANGE_RATE_SCALE = ethers.utils.parseUnits(
  '1',
  TOKEN_EXCHANGE_RATE_DECIMALS,
);
