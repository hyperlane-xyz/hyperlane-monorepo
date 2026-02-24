import type { Address, ReadonlyUint8Array } from '@solana/kit';

import {
  addCodecSizePrefix,
  fixCodecSize,
  getAddressCodec,
  getArrayDecoder,
  getArrayEncoder,
  getBytesCodec,
  getNullableEncoder,
  getNullableCodec,
  getStructDecoder,
  getStructEncoder,
  getU128Codec,
  getU32Codec,
  getU64Codec,
  getU8Codec,
} from '@solana/kit';

import {
  addressBytes,
  ByteCursor,
  ensureLength,
  mapU32,
  u64le,
} from './binary.js';

export type H160 = Uint8Array;
export type H256 = Uint8Array;

export interface RemoteRouterConfig {
  domain: number;
  router: H256 | null;
}

export interface GasRouterConfig {
  domain: number;
  gas: bigint | null;
}

export interface VerifyInstruction {
  metadata: Uint8Array;
  message: Uint8Array;
}

export interface HandleInstruction {
  origin: number;
  sender: H256;
  message: Uint8Array;
}

export interface ValidatorsAndThreshold {
  validators: H160[];
  threshold: number;
}

export interface Domained<T> {
  domain: number;
  data: T;
}

export enum InterchainGasPaymasterTypeKind {
  Igp = 0,
  OverheadIgp = 1,
}

export interface InterchainGasPaymasterType {
  kind: InterchainGasPaymasterTypeKind;
  account: Address;
}

export interface RemoteGasData {
  tokenExchangeRate: bigint;
  gasPrice: bigint;
  tokenDecimals: number;
}

export interface GasOracleRemoteGasData {
  kind: 0;
  value: RemoteGasData;
}

export type GasOracle = GasOracleRemoteGasData;

export interface GasOverheadConfig {
  destinationDomain: number;
  gasOverhead: bigint | null;
}

export interface GasOracleConfig {
  domain: number;
  gasOracle: GasOracle | null;
}

const U8_CODEC = getU8Codec();
const U32_CODEC = getU32Codec();
const U64_CODEC = getU64Codec();
const U128_CODEC = getU128Codec();
const BYTES_CODEC = getBytesCodec();
const BYTES20_CODEC = fixCodecSize(BYTES_CODEC, 20);
const BYTES32_CODEC = fixCodecSize(BYTES_CODEC, 32);
const OPTIONAL_BYTES32_CODEC = getNullableCodec(BYTES32_CODEC);
const OPTIONAL_U64_CODEC = getNullableCodec(U64_CODEC);
const VEC_BYTES_CODEC = addCodecSizePrefix(BYTES_CODEC, U32_CODEC);
const VALIDATOR_ARRAY_ENCODER = getArrayEncoder(BYTES20_CODEC, {
  size: U32_CODEC,
});
const VALIDATOR_ARRAY_DECODER = getArrayDecoder(BYTES20_CODEC, {
  size: U32_CODEC,
});
// Separate encoder/decoder forms are kept to support asymmetric composition when needed.
const VERIFY_INSTRUCTION_ENCODER = getStructEncoder([
  ['metadata', VEC_BYTES_CODEC],
  ['message', VEC_BYTES_CODEC],
]);
const VERIFY_INSTRUCTION_DECODER = getStructDecoder([
  ['metadata', VEC_BYTES_CODEC],
  ['message', VEC_BYTES_CODEC],
]);
const HANDLE_INSTRUCTION_ENCODER = getStructEncoder([
  ['origin', U32_CODEC],
  ['sender', BYTES32_CODEC],
  ['message', VEC_BYTES_CODEC],
]);
const HANDLE_INSTRUCTION_DECODER = getStructDecoder([
  ['origin', U32_CODEC],
  ['sender', BYTES32_CODEC],
  ['message', VEC_BYTES_CODEC],
]);
const REMOTE_ROUTER_CONFIG_ENCODER = getStructEncoder([
  ['domain', U32_CODEC],
  ['router', OPTIONAL_BYTES32_CODEC],
]);
const GAS_ROUTER_CONFIG_ENCODER = getStructEncoder([
  ['domain', U32_CODEC],
  ['gas', OPTIONAL_U64_CODEC],
]);
const VALIDATORS_AND_THRESHOLD_ENCODER = getStructEncoder([
  ['validators', VALIDATOR_ARRAY_ENCODER],
  ['threshold', U8_CODEC],
]);
const VALIDATORS_AND_THRESHOLD_DECODER = getStructDecoder([
  ['validators', VALIDATOR_ARRAY_DECODER],
  ['threshold', U8_CODEC],
]);
const DOMAINED_VALIDATORS_AND_THRESHOLD_ENCODER = getStructEncoder([
  ['domain', U32_CODEC],
  ['data', VALIDATORS_AND_THRESHOLD_ENCODER],
]);
const DOMAINED_VALIDATORS_AND_THRESHOLD_DECODER = getStructDecoder([
  ['domain', U32_CODEC],
  ['data', VALIDATORS_AND_THRESHOLD_DECODER],
]);
const ADDRESS_CODEC = getAddressCodec();
const INTERCHAIN_GAS_PAYMASTER_TYPE_ENCODER = getStructEncoder([
  ['kind', U8_CODEC],
  ['account', ADDRESS_CODEC],
]);
const INTERCHAIN_GAS_PAYMASTER_TYPE_DECODER = getStructDecoder([
  ['kind', U8_CODEC],
  ['account', ADDRESS_CODEC],
]);
const GAS_ORACLE_INNER_ENCODER = getStructEncoder([
  ['kind', U8_CODEC],
  ['tokenExchangeRate', U128_CODEC],
  ['gasPrice', U128_CODEC],
  ['tokenDecimals', U8_CODEC],
]);
const GAS_ORACLE_INNER_DECODER = getStructDecoder([
  ['kind', U8_CODEC],
  ['tokenExchangeRate', U128_CODEC],
  ['gasPrice', U128_CODEC],
  ['tokenDecimals', U8_CODEC],
]);
const OPTIONAL_GAS_ORACLE_ENCODER = getNullableEncoder(
  GAS_ORACLE_INNER_ENCODER,
);
const GAS_OVERHEAD_CONFIG_ENCODER = getStructEncoder([
  ['destinationDomain', U32_CODEC],
  ['gasOverhead', OPTIONAL_U64_CODEC],
]);
const GAS_ORACLE_CONFIG_ENCODER = getStructEncoder([
  ['domain', U32_CODEC],
  ['gasOracle', OPTIONAL_GAS_ORACLE_ENCODER],
]);

export function encodeH160(
  value: string | ReadonlyUint8Array,
): ReadonlyUint8Array {
  return ensureLength(addressBytes(value), 20, 'H160');
}

export function encodeH256(
  value: string | ReadonlyUint8Array,
): ReadonlyUint8Array {
  return ensureLength(addressBytes(value), 32, 'H256');
}

export function decodeH160(cursor: ByteCursor): H160 {
  return cursor.readBytes(20);
}

export function decodeH256(cursor: ByteCursor): H256 {
  return cursor.readBytes(32);
}

export function encodeVerifyInstruction(value: VerifyInstruction): Uint8Array {
  return Uint8Array.from(VERIFY_INSTRUCTION_ENCODER.encode(value));
}

export function decodeVerifyInstruction(cursor: ByteCursor): VerifyInstruction {
  const decoded = cursor.readWithDecoder(VERIFY_INSTRUCTION_DECODER);
  return {
    metadata: Uint8Array.from(decoded.metadata),
    message: Uint8Array.from(decoded.message),
  };
}

export function encodeHandleInstruction(value: HandleInstruction): Uint8Array {
  return Uint8Array.from(HANDLE_INSTRUCTION_ENCODER.encode(value));
}

export function decodeHandleInstruction(cursor: ByteCursor): HandleInstruction {
  const decoded = cursor.readWithDecoder(HANDLE_INSTRUCTION_DECODER);
  return {
    origin: decoded.origin,
    sender: Uint8Array.from(decoded.sender),
    message: Uint8Array.from(decoded.message),
  };
}

export function encodeRemoteRouterConfig(
  value: RemoteRouterConfig,
): Uint8Array {
  return Uint8Array.from(REMOTE_ROUTER_CONFIG_ENCODER.encode(value));
}

export function encodeGasRouterConfig(value: GasRouterConfig): Uint8Array {
  return Uint8Array.from(GAS_ROUTER_CONFIG_ENCODER.encode(value));
}

export function encodeValidatorsAndThreshold(
  value: ValidatorsAndThreshold,
): Uint8Array {
  return Uint8Array.from(VALIDATORS_AND_THRESHOLD_ENCODER.encode(value));
}

export function decodeValidatorsAndThreshold(
  cursor: ByteCursor,
): ValidatorsAndThreshold {
  const decoded = cursor.readWithDecoder(VALIDATORS_AND_THRESHOLD_DECODER);
  return {
    validators: decoded.validators.map((validator) =>
      Uint8Array.from(validator),
    ),
    threshold: decoded.threshold,
  };
}

export function encodeDomainedValidatorsAndThreshold(
  value: Domained<ValidatorsAndThreshold>,
): Uint8Array {
  return Uint8Array.from(
    DOMAINED_VALIDATORS_AND_THRESHOLD_ENCODER.encode(value),
  );
}

export function decodeDomainedValidatorsAndThreshold(
  cursor: ByteCursor,
): Domained<ValidatorsAndThreshold> {
  const decoded = cursor.readWithDecoder(
    DOMAINED_VALIDATORS_AND_THRESHOLD_DECODER,
  );
  return {
    domain: decoded.domain,
    data: {
      validators: decoded.data.validators.map((validator) =>
        Uint8Array.from(validator),
      ),
      threshold: decoded.data.threshold,
    },
  };
}

export function encodeInterchainGasPaymasterType(
  value: InterchainGasPaymasterType,
): Uint8Array {
  return Uint8Array.from(INTERCHAIN_GAS_PAYMASTER_TYPE_ENCODER.encode(value));
}

export function decodeInterchainGasPaymasterType(
  cursor: ByteCursor,
): InterchainGasPaymasterType {
  const decoded = cursor.readWithDecoder(INTERCHAIN_GAS_PAYMASTER_TYPE_DECODER);
  return {
    kind: decoded.kind,
    account: decoded.account,
  };
}

export function encodeGasOracle(value: GasOracle): Uint8Array {
  return Uint8Array.from(
    GAS_ORACLE_INNER_ENCODER.encode({
      kind: value.kind,
      tokenExchangeRate: value.value.tokenExchangeRate,
      gasPrice: value.value.gasPrice,
      tokenDecimals: value.value.tokenDecimals,
    }),
  );
}

export function decodeGasOracle(cursor: ByteCursor): GasOracle {
  const decoded = cursor.readWithDecoder(GAS_ORACLE_INNER_DECODER);
  const kind = decoded.kind;
  if (kind !== 0) {
    throw new Error(`Unsupported gas oracle kind: ${kind}`);
  }
  return {
    kind: 0,
    value: {
      tokenExchangeRate: decoded.tokenExchangeRate,
      gasPrice: decoded.gasPrice,
      tokenDecimals: decoded.tokenDecimals,
    },
  };
}

export function encodeGasOverheadConfig(value: GasOverheadConfig): Uint8Array {
  return Uint8Array.from(GAS_OVERHEAD_CONFIG_ENCODER.encode(value));
}

export function encodeGasOracleConfig(value: GasOracleConfig): Uint8Array {
  return Uint8Array.from(
    GAS_ORACLE_CONFIG_ENCODER.encode({
      domain: value.domain,
      gasOracle: value.gasOracle
        ? {
            kind: value.gasOracle.kind,
            tokenExchangeRate: value.gasOracle.value.tokenExchangeRate,
            gasPrice: value.gasOracle.value.gasPrice,
            tokenDecimals: value.gasOracle.value.tokenDecimals,
          }
        : null,
    }),
  );
}

export function decodeMapU32U64(cursor: ByteCursor): Map<number, bigint> {
  const count = cursor.readU32LE();
  const entries = new Map<number, bigint>();
  for (let i = 0; i < count; i += 1) {
    entries.set(cursor.readU32LE(), cursor.readU64LE());
  }
  return entries;
}

export function decodeMapU32H256(cursor: ByteCursor): Map<number, H256> {
  const count = cursor.readU32LE();
  const entries = new Map<number, H256>();
  for (let i = 0; i < count; i += 1) {
    entries.set(cursor.readU32LE(), cursor.readBytes(32));
  }
  return entries;
}

export function decodeMapU32GasOracle(
  cursor: ByteCursor,
): Map<number, GasOracle> {
  const count = cursor.readU32LE();
  const entries = new Map<number, GasOracle>();
  for (let i = 0; i < count; i += 1) {
    entries.set(cursor.readU32LE(), decodeGasOracle(cursor));
  }
  return entries;
}

export function encodeMapU32H256(
  entries: Map<number, H256>,
): ReadonlyUint8Array {
  return mapU32(entries, (v) => ensureLength(v, 32, 'H256'));
}

export function encodeMapU32U64(
  entries: Map<number, bigint>,
): ReadonlyUint8Array {
  return mapU32(entries, u64le);
}
