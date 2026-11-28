import { utils } from 'ethers';

import { strip0x } from '@hyperlane-xyz/utils';

import { XERC20AevoCapType, XERC20Type } from '../token/types.js';
import { AevoXERC20Limits } from '../token/xerc20-limits.js';

import { AEVO_USDC_IMPLEMENTATION } from './aevoTokenCode.js';

export {
  AEVO_ACCOUNTS,
  AEVO_ACCOUNTS_STAND_IN_CODE,
  AEVO_USDC_IMPLEMENTATION,
  AEVO_USDC_PROXY,
  AEVO_WETH_IMPLEMENTATION,
  aevoTokenCode,
} from './aevoTokenCode.js';

// What the USDC proxy's EIP-1967 implementation slot held.
export function aevoUsdcImplementationSlotValue(): string {
  return utils.hexZeroPad(AEVO_USDC_IMPLEMENTATION, 32);
}

// The selectors of the Aevo token as they appear in its bytecode, written out
// here so a wrong selector in the SDK cannot make the fixture agree with it.
export const AEVO_SELECTORS = {
  authorities: '0x91223d69',
  caps: '0x66d97b21',
  updateAuthority: '0x6cd22eaf',
  setCap: '0x80ad2cf3',
};

// The selectors of the owner of the token, which it carries beside the four
// above but which do not identify it as an Aevo token: `owner()`, and
// `setOwner(address)`, which hands the token over in one step.
export const AEVO_OWNER_SELECTORS = {
  owner: '0x8da5cb5b',
  setOwner: '0x13af4035',
};

// Selectors the Aevo token does not have: the Standard and Velodrome xERC20
// setters and getter, and burn(uint256).
export const AEVO_ABSENT_SELECTORS = [
  '0xa08d5654',
  '0x4499eb15',
  '0x651fd268',
  '0x42966c68',
];

// An ABI word, for building call data and return data by hand.
export function abiWord(value: string | number | bigint): string {
  return strip0x(utils.hexZeroPad(utils.hexlify(value), 32));
}

// The minter the Aevo token authorizes when it is initialized.
export const AEVO_L2_BRIDGE = '0x4200000000000000000000000000000000000010';

// What an Aevo token holds for a minter, as a config states it.
export const aevoUnauthorized = (): AevoXERC20Limits => ({
  type: XERC20Type.Aevo,
  authorized: false,
});
export const aevoRaw = (value: string): AevoXERC20Limits => ({
  type: XERC20Type.Aevo,
  authorized: true,
  cap: { type: XERC20AevoCapType.Raw, value },
});
export const aevoUnlimited = (): AevoXERC20Limits => ({
  type: XERC20Type.Aevo,
  authorized: true,
  cap: { type: XERC20AevoCapType.Unlimited },
});
