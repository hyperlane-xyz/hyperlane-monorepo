import { type Address, getAddressDecoder } from '@solana/kit';

import { assert } from '@hyperlane-xyz/utils';

import {
  decodeAccountData,
  decodeDiscriminatorPrefixed,
} from '../codecs/account-data.js';
import { ByteCursor } from '../codecs/binary.js';
import {
  decodeMapU32GasOracle,
  decodeMapU32H256,
  decodeMapU32U64,
  type GasOracle,
  type InterchainGasPaymasterType,
  InterchainGasPaymasterTypeKind,
} from '../codecs/shared.js';

const IGP_PROGRAM_DATA_DISCRIMINATOR = ascii8('PRGMDATA');
const IGP_ACCOUNT_DISCRIMINATOR = ascii8('IGP_____');
const OVERHEAD_IGP_ACCOUNT_DISCRIMINATOR = ascii8('OVRHDIGP');

export interface HyperlaneTokenAccountData {
  bump: number;
  mailbox: Address;
  mailboxProcessAuthority: Address;
  dispatchAuthorityBump: number;
  decimals: number;
  remoteDecimals: number;
  owner: Address | null;
  interchainSecurityModule: Address | null;
  interchainGasPaymaster: {
    programId: Address;
    igpType: InterchainGasPaymasterType;
  } | null;
  destinationGas: Map<number, bigint>;
  remoteRouters: Map<number, Uint8Array>;
  pluginData: Uint8Array;
  feeConfig: TokenFeeConfig | null;
}

export interface IgpProgramData {
  bumpSeed: number;
  paymentCount: bigint;
}

export interface IgpAccountData {
  bumpSeed: number;
  salt: Uint8Array;
  owner: Address | null;
  beneficiary: Address;
  gasOracles: Map<number, GasOracle>;
}

export interface OverheadIgpAccountData {
  bumpSeed: number;
  salt: Uint8Array;
  owner: Address | null;
  inner: Address;
  gasOverheads: Map<number, bigint>;
}

export function decodeHyperlaneTokenAccount(
  raw: Uint8Array,
  pluginSize: number,
): HyperlaneTokenAccountData | null {
  const wrapped = decodeAccountData(raw, (cursor) =>
    decodeHyperlaneTokenInner(cursor, pluginSize),
  );
  return wrapped.data;
}

export function decodeIgpProgramDataAccount(
  raw: Uint8Array,
): IgpProgramData | null {
  const wrapped = decodeAccountData(raw, (cursor) =>
    decodeDiscriminatorPrefixed(
      cursor,
      IGP_PROGRAM_DATA_DISCRIMINATOR,
      (c) => ({
        bumpSeed: c.readU8(),
        paymentCount: c.readU64LE(),
      }),
    ),
  );
  return wrapped.data;
}

export function decodeIgpAccount(raw: Uint8Array): IgpAccountData | null {
  const wrapped = decodeAccountData(raw, (cursor) =>
    decodeDiscriminatorPrefixed(cursor, IGP_ACCOUNT_DISCRIMINATOR, (c) => ({
      bumpSeed: c.readU8(),
      salt: c.readBytes(32),
      owner: readOptionAddress(c),
      beneficiary: readAddress(c),
      gasOracles: decodeMapU32GasOracle(c),
    })),
  );
  return wrapped.data;
}

export function decodeOverheadIgpAccount(
  raw: Uint8Array,
): OverheadIgpAccountData | null {
  const wrapped = decodeAccountData(raw, (cursor) =>
    decodeDiscriminatorPrefixed(
      cursor,
      OVERHEAD_IGP_ACCOUNT_DISCRIMINATOR,
      (c) => ({
        bumpSeed: c.readU8(),
        salt: c.readBytes(32),
        owner: readOptionAddress(c),
        inner: readAddress(c),
        gasOverheads: decodeMapU32U64(c),
      }),
    ),
  );
  return wrapped.data;
}

function decodeHyperlaneTokenInner(
  cursor: ByteCursor,
  pluginSize: number,
): HyperlaneTokenAccountData {
  const bump = cursor.readU8();
  const mailbox = readAddress(cursor);
  const mailboxProcessAuthority = readAddress(cursor);
  const dispatchAuthorityBump = cursor.readU8();
  const decimals = cursor.readU8();
  const remoteDecimals = cursor.readU8();
  const owner = readOptionAddress(cursor);
  const interchainSecurityModule = readOptionAddress(cursor);
  const interchainGasPaymaster = readOptionIgpConfig(cursor);
  const destinationGas = decodeMapU32U64(cursor);
  const remoteRouters = decodeMapU32H256(cursor);
  const pluginData = cursor.readBytes(pluginSize);

  // fee_config: Option<FeeConfig> — last field, backward-compatible.
  // Pre-fee accounts have no trailing bytes; treat as None.
  let feeConfig: TokenFeeConfig | null = null;
  if (cursor.remaining() > 0) {
    feeConfig = readOptionFeeConfig(cursor);
  }

  return {
    bump,
    mailbox,
    mailboxProcessAuthority,
    dispatchAuthorityBump,
    decimals,
    remoteDecimals,
    owner,
    interchainSecurityModule,
    interchainGasPaymaster,
    destinationGas,
    remoteRouters,
    pluginData,
    feeConfig,
  };
}

// ---------------------------------------------------------------------------
// Token plugin decoders
// Each token type stores plugin-specific data as trailing bytes in the token PDA.
// NativePlugin:    1 byte  (native_collateral_bump)
// SyntheticPlugin: 34 bytes (mint:32, mint_bump:1, ata_payer_bump:1)
// CollateralPlugin:98 bytes (spl_token_program:32, mint:32, escrow:32, escrow_bump:1, ata_payer_bump:1)
// ---------------------------------------------------------------------------

export interface NativePluginData {
  nativeCollateralBump: number;
}

export interface SyntheticPluginData {
  mint: Address;
  mintBump: number;
  ataPayerBump: number;
}

export interface CollateralPluginData {
  splTokenProgram: Address;
  mint: Address;
  escrow: Address;
  escrowBump: number;
  ataPayerBump: number;
}

export function decodeNativePlugin(pluginData: Uint8Array): NativePluginData {
  if (pluginData.length < 1)
    throw new Error(`NativePlugin: need 1 byte, got ${pluginData.length}`);
  return { nativeCollateralBump: pluginData[0] };
}

export function decodeSyntheticPlugin(
  pluginData: Uint8Array,
): SyntheticPluginData {
  if (pluginData.length < 34)
    throw new Error(`SyntheticPlugin: need 34 bytes, got ${pluginData.length}`);
  const cursor = new ByteCursor(pluginData);
  return {
    mint: readAddress(cursor),
    mintBump: cursor.readU8(),
    ataPayerBump: cursor.readU8(),
  };
}

export function decodeCollateralPlugin(
  pluginData: Uint8Array,
): CollateralPluginData {
  if (pluginData.length < 98)
    throw new Error(
      `CollateralPlugin: need 98 bytes, got ${pluginData.length}`,
    );
  const cursor = new ByteCursor(pluginData);
  return {
    splTokenProgram: readAddress(cursor),
    mint: readAddress(cursor),
    escrow: readAddress(cursor),
    escrowBump: cursor.readU8(),
    ataPayerBump: cursor.readU8(),
  };
}

function ascii8(value: string): Uint8Array {
  if (value.length !== 8)
    throw new Error(`Expected 8-char discriminator, got ${value}`);
  return Uint8Array.from(value, (char) => char.charCodeAt(0));
}

const addressDecoder = getAddressDecoder();

function readAddress(cursor: ByteCursor): Address {
  return addressDecoder.decode(cursor.readBytes(32));
}

function readOptionAddress(cursor: ByteCursor): Address | null {
  const tag = cursor.readU8();
  assert(tag === 0 || tag === 1, `Invalid option tag: ${tag}`);
  return tag === 1 ? readAddress(cursor) : null;
}

export interface TokenFeeConfig {
  feeProgram: Address;
  feeAccount: Address;
}

/** Plugin data sizes per token type (bytes). */
export const NATIVE_PLUGIN_SIZE = 1;
export const SYNTHETIC_PLUGIN_SIZE = 34;
export const COLLATERAL_PLUGIN_SIZE = 98;

function readOptionIgpConfig(cursor: ByteCursor): {
  programId: Address;
  igpType: InterchainGasPaymasterType;
} | null {
  const tag = cursor.readU8();
  assert(tag === 0 || tag === 1, `Invalid option tag: ${tag}`);
  if (tag === 0) return null;
  const programId = readAddress(cursor);
  const igpKindByte = cursor.readU8();
  assert(
    igpKindByte === InterchainGasPaymasterTypeKind.Igp ||
      igpKindByte === InterchainGasPaymasterTypeKind.OverheadIgp,
    `Unknown InterchainGasPaymasterType kind: ${igpKindByte}`,
  );
  return {
    programId,
    igpType: {
      kind: igpKindByte,
      account: readAddress(cursor),
    },
  };
}

function readOptionFeeConfig(cursor: ByteCursor): TokenFeeConfig | null {
  const tag = cursor.readU8();
  if (tag === 0) return null;
  assert(tag === 1, `Invalid FeeConfig option tag: ${tag}`);
  const feeProgram = readAddress(cursor);
  const feeAccount = readAddress(cursor);
  return { feeProgram, feeAccount };
}
