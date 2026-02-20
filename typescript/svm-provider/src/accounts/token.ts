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
  InterchainGasPaymasterTypeKind,
  type InterchainGasPaymasterType,
} from '../codecs/shared.js';

const IGP_PROGRAM_DATA_DISCRIMINATOR = ascii8('PRGMDATA');
const IGP_ACCOUNT_DISCRIMINATOR = ascii8('IGP_____');
const OVERHEAD_IGP_ACCOUNT_DISCRIMINATOR = ascii8('OVRHDIGP');

export interface HyperlaneTokenAccountData {
  bump: number;
  mailbox: Uint8Array;
  mailboxProcessAuthority: Uint8Array;
  dispatchAuthorityBump: number;
  decimals: number;
  remoteDecimals: number;
  owner: Uint8Array | null;
  interchainSecurityModule: Uint8Array | null;
  interchainGasPaymaster: {
    programId: Uint8Array;
    igpType: InterchainGasPaymasterType;
  } | null;
  destinationGas: Map<number, bigint>;
  remoteRouters: Map<number, Uint8Array>;
  pluginData: Uint8Array;
}

export interface IgpProgramData {
  bumpSeed: number;
  paymentCount: bigint;
}

export interface IgpAccountData {
  bumpSeed: number;
  salt: Uint8Array;
  owner: Uint8Array | null;
  beneficiary: Uint8Array;
  gasOracles: Map<number, GasOracle>;
}

export interface OverheadIgpAccountData {
  bumpSeed: number;
  salt: Uint8Array;
  owner: Uint8Array | null;
  inner: Uint8Array;
  gasOverheads: Map<number, bigint>;
}

export function decodeHyperlaneTokenAccount(
  raw: Uint8Array,
): HyperlaneTokenAccountData | null {
  const wrapped = decodeAccountData(raw, decodeHyperlaneTokenInner);
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
      owner: readOptionBytes32(c),
      beneficiary: c.readBytes(32),
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
        owner: readOptionBytes32(c),
        inner: c.readBytes(32),
        gasOverheads: decodeMapU32U64(c),
      }),
    ),
  );
  return wrapped.data;
}

function decodeHyperlaneTokenInner(
  cursor: ByteCursor,
): HyperlaneTokenAccountData {
  // Kept manual because payload ends with trailing pluginData (remainder bytes).
  const bump = cursor.readU8();
  const mailbox = cursor.readBytes(32);
  const mailboxProcessAuthority = cursor.readBytes(32);
  const dispatchAuthorityBump = cursor.readU8();
  const decimals = cursor.readU8();
  const remoteDecimals = cursor.readU8();
  const owner = readOptionBytes32(cursor);
  const interchainSecurityModule = readOptionBytes32(cursor);
  const interchainGasPaymaster = readOptionIgpConfig(cursor);
  const destinationGas = decodeMapU32U64(cursor);
  const remoteRouters = decodeMapU32H256(cursor);
  const pluginData = cursor.readBytes(cursor.remaining());

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
  };
}

function ascii8(value: string): Uint8Array {
  if (value.length !== 8)
    throw new Error(`Expected 8-char discriminator, got ${value}`);
  return Uint8Array.from(value, (char) => char.charCodeAt(0));
}

function readOptionBytes32(cursor: ByteCursor): Uint8Array | null {
  const hasValue = cursor.readU8() === 1;
  return hasValue ? cursor.readBytes(32) : null;
}

function readOptionIgpConfig(cursor: ByteCursor): {
  programId: Uint8Array;
  igpType: InterchainGasPaymasterType;
} | null {
  const hasValue = cursor.readU8() === 1;
  if (!hasValue) return null;
  return {
    programId: cursor.readBytes(32),
    igpType: {
      kind: cursor.readU8() as InterchainGasPaymasterTypeKind,
      account: cursor.readBytes(32),
    },
  };
}
