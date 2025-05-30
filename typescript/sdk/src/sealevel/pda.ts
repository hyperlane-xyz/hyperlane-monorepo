/**
 * MUST be equal to the values in
 * {@link https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/55ceece0b8fce3f489afee3e32f69c17bfcb777c/rust/sealevel/libraries/hyperlane-sealevel-token/src/processor.rs#L46-L67|hyperlane_token_pda_seeds}
 */
export const HYPERLANE_TOKEN_METADATA_ACCOUNT_PDA_SEEDS = [
  'hyperlane_message_recipient',
  '-',
  'handle',
  '-',
  'account_metas',
];

/**
 * MUST be equal to the values in
 * {@link https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/55ceece0b8fce3f489afee3e32f69c17bfcb777c/rust/sealevel/programs/hyperlane-sealevel-token-native/src/plugin.rs#L25-L38|hyperlane_token_native_collateral_pda_seeds}
 */
export const HYPERLANE_NATIVE_TOKEN_ACCOUNT_PDA_SEEDS = [
  'hyperlane_token',
  '-',
  'native_collateral',
];

/**
 * MUST be equal to the values in
 * {@link https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/55ceece0b8fce3f489afee3e32f69c17bfcb777c/rust/sealevel/programs/hyperlane-sealevel-token/src/plugin.rs#L32-L40|hyperlane_token_mint_pda_seeds}
 */
export const HYPERLANE_SYNTHETIC_TOKEN_ACCOUNT_PDA_SEEDS = [
  'hyperlane_token',
  '-',
  'mint',
];

/**
 * Must be equal to the values in
 * {@link https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/55ceece0b8fce3f489afee3e32f69c17bfcb777c/rust/sealevel/programs/hyperlane-sealevel-token-collateral/src/plugin.rs#L28-L36|hyperlane_token_escrow_pda_seeds}
 */
export const HYPERLANE_COLLATERAL_TOKEN_ACCOUNT_PDA_SEEDS = [
  'hyperlane_token',
  '-',
  'escrow',
];
