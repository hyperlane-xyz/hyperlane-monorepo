import { PublicKey } from '@solana/web3.js';
import { utils as ethersUtils } from 'ethers';

import { Address, HexString, ProtocolType } from './types';

const EVM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const SEALEVEL_ADDRESS_REGEX = /^[a-zA-Z0-9]{36,44}$/;

const EVM_TX_HASH_REGEX = /^0x([A-Fa-f0-9]{64})$/;
const SEALEVEL_TX_HASH_REGEX = /^[a-zA-Z1-9]{88}$/;

const ZEROISH_ADDRESS_REGEX = /^(0x)?0*$/;

export function isAddressEvm(address: Address) {
  return EVM_ADDRESS_REGEX.test(address);
}

export function isAddressSealevel(address: Address) {
  return SEALEVEL_ADDRESS_REGEX.test(address);
}

export function getAddressProtocolType(address: Address) {
  if (!address) return undefined;
  if (isAddressEvm(address)) {
    return ProtocolType.Ethereum;
  } else if (isAddressSealevel(address)) {
    return ProtocolType.Sealevel;
  } else {
    return undefined;
  }
}

function routeAddressUtil<T>(
  evmFn: (param: string) => T,
  sealevelFn: (param: string) => T,
  fallback: T,
  param: string,
  protocol?: ProtocolType,
) {
  protocol = protocol || getAddressProtocolType(param);
  if (protocol === ProtocolType.Ethereum) {
    return evmFn(param);
  } else if (protocol === ProtocolType.Sealevel) {
    return sealevelFn(param);
  } else {
    return fallback;
  }
}

// Slower than isAddressEvm above but actually validates content and checksum
export function isValidAddressEvm(address: Address) {
  // Need to catch because ethers' isAddress throws in some cases (bad checksum)
  try {
    const isValid = address && ethersUtils.isAddress(address);
    return !!isValid;
  } catch (error) {
    return false;
  }
}

// Slower than isAddressSealevel above but actually validates content and checksum
export function isValidAddressSealevel(address: Address) {
  try {
    const isValid = address && new PublicKey(address).toBase58();
    return !!isValid;
  } catch (error) {
    return false;
  }
}

export function isValidAddress(address: Address, protocol?: ProtocolType) {
  return routeAddressUtil(
    isValidAddressEvm,
    isValidAddressSealevel,
    false,
    address,
    protocol,
  );
}

export function normalizeAddressEvm(address: Address) {
  if (isZeroishAddress(address)) return address;
  try {
    return ethersUtils.getAddress(address);
  } catch (error) {
    return address;
  }
}

export function normalizeAddressSealevel(address: Address) {
  if (isZeroishAddress(address)) return address;
  try {
    return new PublicKey(address).toBase58();
  } catch (error) {
    return address;
  }
}

export function normalizeAddress(address: Address, protocol?: ProtocolType) {
  return routeAddressUtil(
    normalizeAddressEvm,
    normalizeAddressSealevel,
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

export function eqAddress(a1: Address, a2: Address) {
  const p1 = getAddressProtocolType(a1);
  const p2 = getAddressProtocolType(a2);
  if (p1 !== p2) return false;
  return routeAddressUtil(
    (_a1) => eqAddressEvm(_a1, a2),
    (_a1) => eqAddressSol(_a1, a2),
    false,
    a1,
    p1,
  );
}

export function isValidTransactionHashEvm(input: string) {
  return EVM_TX_HASH_REGEX.test(input);
}

export function isValidTransactionHashSealevel(input: string) {
  return SEALEVEL_TX_HASH_REGEX.test(input);
}

export function isValidTransactionHash(input: string, protocol: ProtocolType) {
  if (protocol === ProtocolType.Ethereum) {
    return isValidTransactionHashEvm(input);
  } else if (protocol === ProtocolType.Sealevel) {
    return isValidTransactionHashSealevel(input);
  } else {
    return false;
  }
}

export function isZeroishAddress(address: Address) {
  return ZEROISH_ADDRESS_REGEX.test(address);
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

export function addressToBytes32(address: Address): string {
  return ethersUtils
    .hexZeroPad(ethersUtils.hexStripZeros(address), 32)
    .toLowerCase();
}

export function bytes32ToAddress(bytes32: HexString): Address {
  return ethersUtils.getAddress(bytes32.slice(-40));
}

export function addressToBytesEvm(address: Address): Uint8Array {
  const addrBytes32 = addressToBytes32(address);
  return Buffer.from(addrBytes32.substring(2), 'hex');
}

export function addressToBytesSol(address: Address): Uint8Array {
  return new PublicKey(address).toBytes();
}

export function addressToBytes(address: Address, protocol?: ProtocolType) {
  return routeAddressUtil(
    addressToBytesEvm,
    addressToBytesSol,
    new Uint8Array(),
    address,
    protocol,
  );
}

export function addressToByteHexString(
  address: string,
  protocol?: ProtocolType,
) {
  return '0x' + Buffer.from(addressToBytes(address, protocol)).toString('hex');
}

export function bytesToProtocolAddress(
  bytes: Buffer,
  toProtocol: ProtocolType,
) {
  if (toProtocol === ProtocolType.Sealevel) {
    return new PublicKey(bytes).toBase58();
  } else if (toProtocol === ProtocolType.Ethereum) {
    return bytes32ToAddress(bytes.toString('hex'));
  } else {
    throw new Error(`Unsupported protocol for address ${toProtocol}`);
  }
}

export function convertToProtocolAddress(
  address: string,
  protocol: ProtocolType,
) {
  const currentProtocol = getAddressProtocolType(address);
  if (currentProtocol === protocol) return address;
  if (
    currentProtocol === ProtocolType.Ethereum &&
    protocol === ProtocolType.Sealevel
  ) {
    return new PublicKey(
      addressToBytes(address, ProtocolType.Ethereum),
    ).toBase58();
  } else if (
    currentProtocol === ProtocolType.Sealevel &&
    protocol === ProtocolType.Ethereum
  ) {
    return bytes32ToAddress(
      Buffer.from(addressToBytes(address, ProtocolType.Sealevel)).toString(
        'hex',
      ),
    );
  } else {
    throw new Error(
      `Unsupported protocol combination ${currentProtocol} -> ${protocol}`,
    );
  }
}

export function ensure0x(hexstr: string) {
  return hexstr.startsWith('0x') ? hexstr : `0x${hexstr}`;
}

export function strip0x(hexstr: string) {
  return hexstr.startsWith('0x') ? hexstr.slice(2) : hexstr;
}
