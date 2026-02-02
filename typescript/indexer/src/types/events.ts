import type { Block, Log, Transaction, TransactionReceipt } from 'viem';
import { keccak256 } from 'viem';

/**
 * Ponder event context types for Hyperlane contracts.
 */

// =============================================================================
// Mailbox Events
// =============================================================================

export interface DispatchEventArgs {
  sender: `0x${string}`;
  destination: number;
  recipient: `0x${string}`;
  message: `0x${string}`;
}

export interface DispatchIdEventArgs {
  messageId: `0x${string}`;
}

export interface ProcessEventArgs {
  origin: number;
  sender: `0x${string}`;
  recipient: `0x${string}`;
}

export interface ProcessIdEventArgs {
  messageId: `0x${string}`;
}

// =============================================================================
// IGP Events
// =============================================================================

export interface GasPaymentEventArgs {
  messageId: `0x${string}`;
  destinationDomain: number;
  gasAmount: bigint;
  payment: bigint;
}

// =============================================================================
// MerkleTreeHook Events
// =============================================================================

export interface InsertedIntoTreeEventArgs {
  messageId: `0x${string}`;
  index: number;
}

// =============================================================================
// Ponder Context Types
// =============================================================================

export interface PonderEventContext<TArgs> {
  event: {
    args: TArgs;
    log: Log;
    block: Block;
    transaction: Transaction;
    transactionReceipt?: TransactionReceipt;
  };
  context: {
    network: {
      chainId: number;
      name: string;
    };
    contracts: {
      Mailbox?: { address: `0x${string}` };
      InterchainGasPaymaster?: { address: `0x${string}` };
      MerkleTreeHook?: { address: `0x${string}` };
    };
  };
}

// =============================================================================
// Message parsing utilities
// =============================================================================

/**
 * Parse a Hyperlane message from raw bytes.
 * Message format (v3):
 * - version: 1 byte
 * - nonce: 4 bytes
 * - origin: 4 bytes
 * - sender: 32 bytes
 * - destination: 4 bytes
 * - recipient: 32 bytes
 * - body: remaining bytes
 */
export interface ParsedMessage {
  version: number;
  nonce: number;
  origin: number;
  sender: `0x${string}`;
  destination: number;
  recipient: `0x${string}`;
  body: `0x${string}`;
}

export function parseMessage(message: `0x${string}`): ParsedMessage {
  const data = Buffer.from(message.slice(2), 'hex');

  if (data.length < 77) {
    throw new Error(`Invalid message length: ${data.length}`);
  }

  let offset = 0;

  const version = data.readUInt8(offset);
  offset += 1;

  const nonce = data.readUInt32BE(offset);
  offset += 4;

  const origin = data.readUInt32BE(offset);
  offset += 4;

  const sender =
    `0x${data.subarray(offset, offset + 32).toString('hex')}` as `0x${string}`;
  offset += 32;

  const destination = data.readUInt32BE(offset);
  offset += 4;

  const recipient =
    `0x${data.subarray(offset, offset + 32).toString('hex')}` as `0x${string}`;
  offset += 32;

  const body = `0x${data.subarray(offset).toString('hex')}` as `0x${string}`;

  return {
    version,
    nonce,
    origin,
    sender,
    destination,
    recipient,
    body,
  };
}

/**
 * Compute message ID from raw message bytes.
 * Message ID is keccak256 hash of the message.
 */
export function computeMessageId(message: `0x${string}`): `0x${string}` {
  return keccak256(message);
}

/**
 * Extract sender address from 32-byte padded format.
 */
export function extractAddress(padded: `0x${string}`): `0x${string}` {
  // For EVM, address is in the last 20 bytes
  if (padded.length !== 66) {
    throw new Error(`Invalid padded address length: ${padded.length}`);
  }
  return `0x${padded.slice(-40)}` as `0x${string}`;
}
