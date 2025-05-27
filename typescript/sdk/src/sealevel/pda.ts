import { PublicKey } from '@solana/web3.js';

export const HYPERLANE_TOKEN_PDA_SEEDS = [
  Buffer.from('hyperlane_message_recipient'),
  Buffer.from('-'),
  Buffer.from('handle'),
  Buffer.from('-'),
  Buffer.from('account_metas'),
];

export const HYPERLANE_NATIVE_TOKEN_PDA_SEEDS = [
  Buffer.from('hyperlane_token'),
  Buffer.from('-'),
  Buffer.from('native_collateral'),
];

export const HYPERLANE_SYNTHETIC_TOKEN_PDA_SEEDS = [
  Buffer.from('hyperlane_token'),
  Buffer.from('-'),
  Buffer.from('mint'),
];

export const HYPERLANE_COLLATERAL_TOKEN_PDA_SEEDS = [
  Buffer.from('hyperlane_token'),
  Buffer.from('-'),
  Buffer.from('escrow'),
];

export const HYPERLANE_TOKEN_METADATA_ACCOUNT_PDA_SEEDS = [
  'hyperlane_message_recipient',
  '-',
  'handle',
  '-',
  'account_metas',
];

export const SvmSystemProgram = new PublicKey(
  '11111111111111111111111111111111',
);
