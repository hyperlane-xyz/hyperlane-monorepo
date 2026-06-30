import { TronWeb } from 'tronweb';

import {
  addressToBytesTron,
  assert,
  bytesToAddressTron,
  strip0x,
} from '@hyperlane-xyz/utils';

import { IABI } from './types.js';
import { BigNumber, providers } from 'ethers';

export const TRON_EMPTY_ADDRESS = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
export const TRON_EMPTY_MESSAGE =
  '0x0000000000000000000000000000000000000000000000000000000000000000';
export const EIP1967_ADMIN_SLOT =
  '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';

export function decodeRevertReason(hex: string, tronweb: any): string {
  try {
    if (hex.startsWith('08c379a0')) {
      // Standard Error(string) selector
      const data = '0x' + hex.substring(8);
      // Decode using TronWeb's internal ethers.js util
      return tronweb.utils.abi.decodeParams(['string'], data)[0];
    }
    return `Hex Error: ${hex}`;
  } catch {
    return `Could not decode hex: ${hex}`;
  }
}

export async function createDeploymentTransaction(
  tronweb: Readonly<TronWeb>,
  abi: IABI,
  signer: string,
  parameters: unknown[],
): Promise<any> {
  return tronweb.transactionBuilder.createSmartContract(
    {
      feeLimit: 1_000_000_000,
      abi: abi.abi,
      bytecode: abi.bytecode,
      parameters,
      name: abi.contractName,
    },
    signer,
  );
}

/**
 * Constructs MetaProxy bytecode that embeds metadata in the contract
 * @param implementationAddress - Address of implementation contract
 * @param metadata - ABI-encoded metadata to embed
 * @returns Complete MetaProxy bytecode
 */
export function buildMetaProxyBytecode(
  implementationAddress: string,
  metadata: string,
  prefix = '41',
): string {
  const PREFIX =
    '600b380380600b3d393df3363d3d373d3d3d3d60368038038091363936013d73';
  const SUFFIX = '5af43d3d93803e603457fd5bf3';

  // Remove 0x prefix if present
  const cleanMetadata = strip0x(metadata);
  let cleanImpl = strip0x(implementationAddress);

  // Tron addresses have a prefix byte (e.g. '41' for Tron, '44' for Ultima) - strip it to get 20 bytes
  if (cleanImpl.startsWith(prefix.toLowerCase())) {
    cleanImpl = cleanImpl.slice(prefix.length);
  }

  // Validate address is exactly 20 bytes (40 hex chars)
  if (cleanImpl.length !== 40) {
    throw new Error(
      `Implementation address must be 20 bytes (40 hex chars), got ${cleanImpl.length}`,
    );
  }

  // Convert metadata length to 32-byte hex (uint256)
  const metadataLength = (cleanMetadata.length / 2)
    .toString(16)
    .padStart(64, '0');

  return `0x${PREFIX}${cleanImpl}${SUFFIX}${cleanMetadata}${metadataLength}`;
}

/**
 * Deploys a contract using raw bytecode (for MetaProxy deployments)
 * @param tronweb - TronWeb instance
 * @param bytecode - Complete bytecode to deploy
 * @param signer - Deployer address
 * @param contractName - Optional name for the contract
 * @returns Transaction object
 */
export async function createRawBytecodeDeploymentTransaction(
  tronweb: Readonly<TronWeb>,
  bytecode: string,
  signer: string,
  contractName = 'MetaProxy',
): Promise<any> {
  return tronweb.transactionBuilder.createSmartContract(
    {
      feeLimit: 1_000_000_000,
      abi: [],
      bytecode,
      parameters: [],
      name: contractName,
    },
    signer,
  );
}

/** Convert ethers 0x address to Tron-prefixed hex (default prefix '41' for Tron mainnet). */
export function toTronHex(address: string, prefix = '41'): string {
  return prefix + strip0x(address).toLowerCase();
}

/**
 * Convert a Tron/Ultima base58 or EVM 0x address to a tron-protocol hex address.
 * Unlike toTronHex (which assumes EVM input), this handles base58 Tron addresses too.
 */
export function tronAddressToHex(address: string, prefix = '41'): string {
  if (address.startsWith('0x') || address.startsWith('0X')) {
    return prefix + strip0x(address).toLowerCase();
  }
  // base58 tron address — decode to 20 raw bytes, re-encode with given prefix
  const prefixByte = parseInt(prefix, 16);
  const bytes = addressToBytesTron(address, prefixByte);
  return prefix + Buffer.from(bytes).toString('hex');
}

/**
 * Convert a 21-byte tron-protocol hex address (e.g. "41abc..." or "44abc...") to base58check.
 * The prefix byte is embedded in the hex string; no explicit prefix param needed.
 */
export function fromTronHex(hex: string): string {
  const bytes = new Uint8Array(Buffer.from(hex, 'hex')); // 21 bytes
  return bytesToAddressTron(bytes.slice(1), bytes[0]);
}

export async function convertEthersToTronTransaction(
  tronWeb: Readonly<TronWeb>,
  tx: providers.TransactionRequest,
  sender: string,
  prefix = '41',
): Promise<any> {
  assert(tx.to, 'Transaction must have a destination address');
  // Contract call - use 'input' option for raw ABI-encoded calldata
  const tronHexTo = toTronHex(tx.to, prefix);
  const callValue = tx.value ? BigNumber.from(tx.value).toNumber() : 0;

  const result = await tronWeb.transactionBuilder.triggerSmartContract(
    tronHexTo,
    '', // Empty functionSelector since we pass raw encoded data via input
    {
      callValue,
      input: tx.data ? strip0x(tx.data.toString()) : undefined,
    },
    [],
    sender,
  );
  assert(
    result.result?.result,
    `triggerSmartContract failed: ${result.result?.message}`,
  );
  return result.transaction;
}
