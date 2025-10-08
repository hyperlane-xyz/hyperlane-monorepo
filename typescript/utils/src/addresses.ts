import { fromBech32, normalizeBech32, toBech32 } from '@cosmjs/encoding';
import { PublicKey } from '@solana/web3.js';
import { bech32m } from 'bech32';
import { Wallet, utils as ethersUtils } from 'ethers';
import {
  addAddressPadding,
  encode,
  num,
  validateAndParseAddress,
} from 'starknet';

import { isNullish } from './typeof.js';
import { Address, HexString, ProtocolType } from './types.js';
import { assert } from './validation.js';

const EVM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const SEALEVEL_ADDRESS_REGEX = /^[a-zA-Z0-9]{36,44}$/;
const COSMOS_NATIVE_ADDRESS_REGEX = /^(0x)?[0-9a-fA-F]{64}$/;
const STARKNET_ADDRESS_REGEX = /^(0x)?[0-9a-fA-F]{64}$/;
const RADIX_ADDRESS_REGEX =
  /^(account|component)_(rdx|sim|tdx_[\d]_)[a-z0-9]{55}$/;

const HEX_BYTES32_REGEX = /^0x[a-fA-F0-9]{64}$/;

// https://github.com/cosmos/cosmos-sdk/blob/84c33215658131d87daf3c629e909e12ed9370fa/types/coin.go#L601C17-L601C44
const COSMOS_DENOM_PATTERN = `[a-zA-Z][a-zA-Z0-9]{2,127}`;
// https://en.bitcoin.it/wiki/BIP_0173
const BECH32_ADDRESS_PATTERN = `[a-zA-Z]{1,83}1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38,58}`;
const COSMOS_ADDRESS_REGEX = new RegExp(`^${BECH32_ADDRESS_PATTERN}$`);
const IBC_DENOM_REGEX = new RegExp(`^ibc/([A-Fa-f0-9]{64})$`);
const COSMOS_FACTORY_TOKEN_REGEX = new RegExp(
  `^factory/(${BECH32_ADDRESS_PATTERN})/${COSMOS_DENOM_PATTERN}$`,
);

const EVM_TX_HASH_REGEX = /^0x([A-Fa-f0-9]{64})$/;
const SEALEVEL_TX_HASH_REGEX = /^[a-zA-Z1-9]{88}$/;
const COSMOS_TX_HASH_REGEX = /^(0x)?[A-Fa-f0-9]{64}$/;
const STARKNET_TX_HASH_REGEX = /^(0x)?[0-9a-fA-F]{64}$/;
const RADIX_TX_HASH_REGEX = /^txid_(rdx|sim|tdx_[\d]_)[a-z0-9]{59}$/;

const EVM_ZEROISH_ADDRESS_REGEX = /^(0x)?0*$/;
const SEALEVEL_ZEROISH_ADDRESS_REGEX = /^1+$/;
const COSMOS_ZEROISH_ADDRESS_REGEX = /^[a-z]{1,10}?1[0]+$/;
const COSMOS_NATIVE_ZEROISH_ADDRESS_REGEX = /^(0x)?0*$/;
const STARKNET_ZEROISH_ADDRESS_REGEX = /^(0x)?0*$/;
const RADIX_ZEROISH_ADDRESS_REGEX = /^0*$/;

export const ZERO_ADDRESS_HEX_32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

export function isAddressEvm(address: Address) {
  return EVM_ADDRESS_REGEX.test(address);
}

export function isAddressSealevel(address: Address) {
  return SEALEVEL_ADDRESS_REGEX.test(address);
}

export function isAddressCosmos(address: Address) {
  return (
    COSMOS_ADDRESS_REGEX.test(address) ||
    IBC_DENOM_REGEX.test(address) ||
    COSMOS_FACTORY_TOKEN_REGEX.test(address)
  );
}

export function isAddressCosmosNative(address: Address) {
  return COSMOS_NATIVE_ADDRESS_REGEX.test(address);
}

export function isCosmosIbcDenomAddress(address: Address): boolean {
  return IBC_DENOM_REGEX.test(address);
}

export function isAddressStarknet(address: Address) {
  return STARKNET_ADDRESS_REGEX.test(address);
}

export function isAddressRadix(address: Address) {
  return RADIX_ADDRESS_REGEX.test(address);
}

export function getAddressProtocolType(address: Address) {
  if (!address) return undefined;
  if (isAddressEvm(address)) {
    return ProtocolType.Ethereum;
  } else if (isAddressCosmos(address)) {
    return ProtocolType.Cosmos;
  } else if (isAddressCosmosNative(address)) {
    return ProtocolType.CosmosNative;
  } else if (isAddressSealevel(address)) {
    return ProtocolType.Sealevel;
  } else if (isAddressStarknet(address)) {
    return ProtocolType.Starknet;
  } else if (isAddressRadix(address)) {
    return ProtocolType.Radix;
  } else {
    return undefined;
  }
}

export function isAddress(address: Address) {
  return !!getAddressProtocolType(address);
}

function routeAddressUtil<T>(
  fns: Partial<Record<ProtocolType, (param: string) => T>>,
  param: string,
  fallback?: T,
  protocol?: ProtocolType,
) {
  protocol ||= getAddressProtocolType(param);
  if (protocol && fns[protocol]) return fns[protocol]!(param);
  else if (!isNullish(fallback)) return fallback;
  else throw new Error(`Unsupported protocol ${protocol}`);
}

// Slower than isAddressEvm above but actually validates content and checksum
export function isValidAddressEvm(address: Address) {
  // Need to catch because ethers' isAddress throws in some cases (bad checksum)
  try {
    const isValid = address && ethersUtils.isAddress(address);
    return !!isValid;
  } catch {
    return false;
  }
}

// Slower than isAddressSealevel above but actually validates content and checksum
export function isValidAddressSealevel(address: Address) {
  try {
    const isValid = address && new PublicKey(address).toBase58();
    return !!isValid;
  } catch {
    return false;
  }
}

// Slower than isAddressCosmos above but actually validates content and checksum
export function isValidAddressCosmos(address: Address) {
  try {
    const isValid =
      address &&
      (IBC_DENOM_REGEX.test(address) ||
        COSMOS_FACTORY_TOKEN_REGEX.test(address) ||
        fromBech32(address));
    return !!isValid;
  } catch {
    return false;
  }
}

export function isValidAddressStarknet(address: Address) {
  try {
    const isValid = address && validateAndParseAddress(address);
    return !!isValid;
  } catch {
    return false;
  }
}

export function isValidAddressRadix(address: Address) {
  try {
    const isValid = address && RADIX_ADDRESS_REGEX.test(address);
    return !!isValid;
  } catch {
    return false;
  }
}

export function isValidSovereignAddress(_address: Address) {
  // TODO: figure out how to determine this, need extra context from the rollup
  return true;
}

export function isValidAddress(address: Address, protocol?: ProtocolType) {
  return routeAddressUtil(
    {
      [ProtocolType.Ethereum]: isValidAddressEvm,
      [ProtocolType.Sealevel]: isValidAddressSealevel,
      [ProtocolType.Cosmos]: isValidAddressCosmos,
      [ProtocolType.CosmosNative]: isValidAddressCosmos,
      [ProtocolType.Starknet]: isValidAddressStarknet,
      [ProtocolType.Radix]: isValidAddressRadix,
      [ProtocolType.Sovereign]: isValidSovereignAddress,
    },
    address,
    false,
    protocol,
  );
}

export function normalizeAddressEvm(address: Address) {
  if (isZeroishAddress(address)) return address;
  try {
    return ethersUtils.getAddress(address);
  } catch {
    return address;
  }
}

export function normalizeAddressSealevel(address: Address) {
  if (isZeroishAddress(address)) return address;
  try {
    return new PublicKey(address).toBase58();
  } catch {
    return address;
  }
}

export function normalizeAddressCosmos(address: Address) {
  if (isZeroishAddress(address)) return address;
  try {
    return normalizeBech32(address);
  } catch {
    return address;
  }
}

export function normalizeAddressStarknet(address: Address) {
  if (isZeroishAddress(address)) return address;
  try {
    return validateAndParseAddress(address);
  } catch {
    return address;
  }
}

export function normalizeAddressRadix(address: Address) {
  return address;
}

export function normalizeAddress(address: Address, protocol?: ProtocolType) {
  return routeAddressUtil(
    {
      [ProtocolType.Ethereum]: normalizeAddressEvm,
      [ProtocolType.Sealevel]: normalizeAddressSealevel,
      [ProtocolType.Cosmos]: normalizeAddressCosmos,
      [ProtocolType.CosmosNative]: normalizeAddressCosmos,
      [ProtocolType.Starknet]: normalizeAddressStarknet,
      [ProtocolType.Radix]: normalizeAddressRadix,
    },
    address,
    address,
    protocol,
  );
}

export function eqAddressEvm(a1: Address, a2: Address) {
  return normalizeAddressEvm(a1) === normalizeAddressEvm(a2);
}

export function eqAddressSol(a1: Address, a2: Address) {
  return normalizeAddressSealevel(a1) === normalizeAddressSealevel(a2);
}

export function eqAddressCosmos(a1: Address, a2: Address) {
  return normalizeAddressCosmos(a1) === normalizeAddressCosmos(a2);
}

export function eqAddressStarknet(a1: Address, a2: Address) {
  return normalizeAddressStarknet(a1) === normalizeAddressStarknet(a2);
}

export function eqAddressRadix(a1: Address, a2: Address) {
  return normalizeAddressRadix(a1) === normalizeAddressRadix(a2);
}

export function eqAddress(a1: Address, a2: Address) {
  const p1 = getAddressProtocolType(a1);
  const p2 = getAddressProtocolType(a2);
  if (p1 !== p2) return false;
  return routeAddressUtil(
    {
      [ProtocolType.Ethereum]: (_a1) => eqAddressEvm(_a1, a2),
      [ProtocolType.Sealevel]: (_a1) => eqAddressSol(_a1, a2),
      [ProtocolType.Cosmos]: (_a1) => eqAddressCosmos(_a1, a2),
      [ProtocolType.CosmosNative]: (_a1) => eqAddressCosmos(_a1, a2),
      [ProtocolType.Starknet]: (_a1) => eqAddressStarknet(_a1, a2),
      [ProtocolType.Radix]: (_a1) => eqAddressRadix(_a1, a2),
    },
    a1,
    false,
    p1,
  );
}

export function isValidTransactionHashEvm(input: string) {
  return EVM_TX_HASH_REGEX.test(input);
}

export function isValidTransactionHashSealevel(input: string) {
  return SEALEVEL_TX_HASH_REGEX.test(input);
}

export function isValidTransactionHashCosmos(input: string) {
  return COSMOS_TX_HASH_REGEX.test(input);
}

export function isValidTransactionHashStarknet(input: string) {
  return STARKNET_TX_HASH_REGEX.test(input);
}

export function isValidTransactionHashRadix(input: string) {
  return RADIX_TX_HASH_REGEX.test(input);
}

export function isValidTransactionHash(input: string, protocol: ProtocolType) {
  if (protocol === ProtocolType.Ethereum) {
    return isValidTransactionHashEvm(input);
  } else if (protocol === ProtocolType.Sealevel) {
    return isValidTransactionHashSealevel(input);
  } else if (protocol === ProtocolType.Cosmos) {
    return isValidTransactionHashCosmos(input);
  } else if (protocol === ProtocolType.CosmosNative) {
    return isValidTransactionHashCosmos(input);
  } else if (protocol === ProtocolType.Starknet) {
    return isValidTransactionHashStarknet(input);
  } else if (protocol === ProtocolType.Radix) {
    return isValidTransactionHashRadix(input);
  } else {
    return false;
  }
}

export function isZeroishAddress(address: Address) {
  return (
    EVM_ZEROISH_ADDRESS_REGEX.test(address) ||
    SEALEVEL_ZEROISH_ADDRESS_REGEX.test(address) ||
    COSMOS_ZEROISH_ADDRESS_REGEX.test(address) ||
    COSMOS_NATIVE_ZEROISH_ADDRESS_REGEX.test(address) ||
    STARKNET_ZEROISH_ADDRESS_REGEX.test(address) ||
    RADIX_ZEROISH_ADDRESS_REGEX.test(address)
  );
}

export function shortenAddress(address: Address, capitalize?: boolean) {
  if (!address) return '';
  if (address.length < 8) return address;
  const normalized = normalizeAddress(address);
  const shortened =
    normalized.substring(0, 5) +
    '...' +
    normalized.substring(normalized.length - 4);
  return capitalize ? capitalizeAddress(shortened) : shortened;
}

export function capitalizeAddress(address: Address) {
  if (address.startsWith('0x'))
    return '0x' + address.substring(2).toUpperCase();
  else return address.toUpperCase();
}

export function addressToBytes32Evm(address: Address): string {
  return ethersUtils
    .hexZeroPad(ethersUtils.hexStripZeros(address), 32)
    .toLowerCase();
}

// For EVM addresses only, kept for backwards compatibility and convenience
export function bytes32ToAddress(bytes32: HexString): Address {
  return ethersUtils.getAddress(bytes32.slice(-40));
}

export function addressToBytesEvm(address: Address): Uint8Array {
  const addrBytes32 = addressToBytes32Evm(address);
  return Buffer.from(strip0x(addrBytes32), 'hex');
}

export function addressToBytesSol(address: Address): Uint8Array {
  return new PublicKey(address).toBytes();
}

export function addressToBytesCosmos(address: Address): Uint8Array {
  return fromBech32(address).data;
}

export function addressToBytesCosmosNative(address: Address): Uint8Array {
  return Buffer.from(strip0x(address), 'hex');
}

export function addressToBytesStarknet(address: Address): Uint8Array {
  const normalizedAddress = normalizeAddressStarknet(address);
  return num.hexToBytes(normalizedAddress);
}

export function addressToBytesRadix(address: Address): Uint8Array {
  let byteArray = new Uint8Array(
    bech32m.fromWords(bech32m.decode(address).words),
  );

  // Ensure the byte array is 32 bytes long, padding from the left if necessary
  if (byteArray.length < 32) {
    const paddedArray = new Uint8Array(32);
    paddedArray.set(byteArray, 32 - byteArray.length);
    byteArray = paddedArray;
  }

  return byteArray;
}

export function addressToBytesSovereign(address: Address): Uint8Array {
  try {
    const data = bech32m.fromWords(bech32m.decode(address).words);
    if (data.length != 28) {
      throw new Error('Sovereign bech32m addresses must be exactly 28 bytes');
    }
    return new Uint8Array(data);
  } catch {
    return addressToBytesSol(address);
  }
}

export function addressToBytes(
  address: Address,
  protocol?: ProtocolType,
): Uint8Array {
  const bytes = routeAddressUtil(
    {
      [ProtocolType.Ethereum]: addressToBytesEvm,
      [ProtocolType.Sealevel]: addressToBytesSol,
      [ProtocolType.Cosmos]: addressToBytesCosmos,
      [ProtocolType.CosmosNative]: addressToBytesCosmosNative,
      [ProtocolType.Starknet]: addressToBytesStarknet,
      [ProtocolType.Radix]: addressToBytesRadix,
      [ProtocolType.Sovereign]: addressToBytesSovereign,
    },
    address,
    new Uint8Array(),
    protocol,
  );
  assert(
    bytes.length && !bytes.every((b) => b == 0),
    'address bytes must not be empty',
  );
  return bytes;
}

export function addressToByteHexString(
  address: string,
  protocol?: ProtocolType,
) {
  return ensure0x(
    Buffer.from(addressToBytes(address, protocol)).toString('hex'),
  );
}

export function addressToBytes32(
  address: Address,
  protocol?: ProtocolType,
): string {
  // If the address is already bytes32, just return, avoiding a regression
  // where an already bytes32 address cannot be categorized as a protocol address.
  if (HEX_BYTES32_REGEX.test(ensure0x(address))) return ensure0x(address);

  const bytes = addressToBytes(address, protocol);
  return bytesToBytes32(bytes);
}

export function bytesToBytes32(bytes: Uint8Array): string {
  if (bytes.length > 32) {
    throw new Error('bytes must be 32 bytes or less');
  }
  // This 0x-prefixes the hex string
  return ethersUtils.hexZeroPad(
    ensure0x(Buffer.from(bytes).toString('hex')),
    32,
  );
}

// Pad bytes to a certain length, padding with 0s at the start
export function padBytesToLength(bytes: Uint8Array, length: number) {
  if (bytes.length > length) {
    throw new Error(`bytes must be ${length} bytes or less`);
  }
  return Buffer.concat([Buffer.alloc(length - bytes.length), bytes]);
}

export function bytesToAddressEvm(bytes: Uint8Array): Address {
  return bytes32ToAddress(Buffer.from(bytes).toString('hex'));
}

export function bytesToAddressSol(bytes: Uint8Array): Address {
  return new PublicKey(bytes).toBase58();
}

export function bytesToAddressCosmos(
  bytes: Uint8Array,
  prefix: string,
): Address {
  if (!prefix) throw new Error('Prefix required for Cosmos address');
  return toBech32(prefix, bytes);
}

export function bytesToAddressCosmosNative(
  bytes: Uint8Array,
  prefix: string,
): Address {
  if (!prefix) throw new Error('Prefix required for Cosmos Native address');

  // if the bytes are of length 32 we have to check if the bytes are a cosmos
  // native account address or an ID from the hyperlane cosmos module. A cosmos
  // native account address is padded with 12 bytes in front.
  if (bytes.length === 32) {
    if (bytes.slice(0, 12).every((b) => !b)) {
      // since the first 12 bytes are empty we know it is an account address
      return toBech32(prefix, bytes.slice(12));
    }
    // else it is an ID from the hyperlane cosmos module and we just need
    // to represent the bytes in hex
    return ensure0x(Buffer.from(bytes).toString('hex'));
  }

  return toBech32(prefix, bytes);
}

export function bytesToAddressStarknet(bytes: Uint8Array): Address {
  const hexString = encode.buf2hex(bytes);
  return addAddressPadding(hexString);
}

export function bytesToAddressRadix(
  bytes: Uint8Array,
  prefix: string,
): Address {
  if (!prefix) throw new Error('Prefix required for Radix address');
  // If the bytes array is larger than or equal to 30 bytes, take the last 30 bytes
  // Otherwise, pad with zeros from the left up to 30 bytes
  if (bytes.length >= 30) {
    bytes = bytes.slice(bytes.length - 30);
  } else {
    const paddedBytes = new Uint8Array(30);
    paddedBytes.set(bytes, 30 - bytes.length);
    bytes = paddedBytes;
  }

  return bech32m.encode(prefix, bech32m.toWords(bytes));
}

export function bytesToAddressSovereign(
  bytes: Uint8Array,
  prefix?: string,
): Address {
  if (prefix) {
    if (bytes.length != 28) {
      throw new Error('Sovereign bech32m addresses must be exactly 28 bytes');
    }
    return bech32m.encode(prefix, bech32m.toWords(bytes));
  }

  // assume base58 if no prefix
  return new PublicKey(bytes).toBase58(); // TODO: Maybe truncate to 28 bytes
}

export function bytesToProtocolAddress(
  bytes: Uint8Array,
  toProtocol: ProtocolType,
  prefix?: string,
) {
  assert(
    bytes.length && !bytes.every((b) => b == 0),
    'address bytes must not be empty',
  );
  if (toProtocol === ProtocolType.Ethereum) {
    return bytesToAddressEvm(bytes);
  } else if (toProtocol === ProtocolType.Sealevel) {
    return bytesToAddressSol(bytes);
  } else if (toProtocol === ProtocolType.Cosmos) {
    return bytesToAddressCosmos(bytes, prefix!);
  } else if (toProtocol === ProtocolType.CosmosNative) {
    return bytesToAddressCosmosNative(bytes, prefix!);
  } else if (toProtocol === ProtocolType.Starknet) {
    return bytesToAddressStarknet(bytes);
  } else if (toProtocol === ProtocolType.Radix) {
    return bytesToAddressRadix(bytes, prefix!);
  } else if (toProtocol === ProtocolType.Sovereign) {
    return bytesToAddressSovereign(bytes, prefix);
  } else {
    throw new Error(`Unsupported protocol for address ${toProtocol}`);
  }
}

export function convertToProtocolAddress(
  address: string,
  protocol: ProtocolType,
  prefix?: string,
) {
  const currentProtocol = getAddressProtocolType(address);
  if (!currentProtocol)
    throw new Error(`Unknown address protocol for ${address}`);
  if (currentProtocol === protocol) return address;
  const addressBytes = addressToBytes(address, currentProtocol);
  return bytesToProtocolAddress(addressBytes, protocol, prefix);
}

export function ensure0x(hexstr: string) {
  return hexstr.startsWith('0x') ? hexstr : `0x${hexstr}`;
}

export function strip0x(hexstr: string) {
  return hexstr.startsWith('0x') ? hexstr.slice(2) : hexstr;
}

export function isPrivateKeyEvm(privateKey: string): boolean {
  try {
    return new Wallet(privateKey).privateKey === privateKey;
  } catch {
    throw new Error('Provided Private Key is not EVM compatible!');
  }
}

export function hexToRadixCustomPrefix(
  hex: string,
  module: string,
  prefix?: string,
  length = 32,
) {
  let bytes = addressToBytes(hex);
  bytes = bytes.slice(bytes.length - length);
  prefix = prefix || 'account_rdx';
  prefix = prefix.replace('account', module);
  return bech32m.encode(prefix, bech32m.toWords(bytes));
}
