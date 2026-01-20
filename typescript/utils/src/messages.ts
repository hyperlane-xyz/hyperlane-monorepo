import { BigNumber, ethers, utils } from 'ethers';

import { addressToBytes32 } from './addresses.js';
import { fromHexString, toHexString } from './strings.js';
import {
  Address,
  Domain,
  HexString,
  ParsedMessage,
  ParsedWarpRouteMessage,
} from './types.js';

/**
 * JS Implementation of solidity/contracts/libs/Message.sol#formatMessage
 * @returns Hex string of the packed message
 */
export const formatMessage = (
  version: number | BigNumber,
  nonce: number | BigNumber,
  originDomain: Domain,
  senderAddr: Address,
  destinationDomain: Domain,
  recipientAddr: Address,
  body: HexString,
): HexString => {
  senderAddr = addressToBytes32(senderAddr);
  recipientAddr = addressToBytes32(recipientAddr);

  return ethers.utils.solidityPack(
    ['uint8', 'uint32', 'uint32', 'bytes32', 'uint32', 'bytes32', 'bytes'],
    [
      version,
      nonce,
      originDomain,
      senderAddr,
      destinationDomain,
      recipientAddr,
      body,
    ],
  );
};

/**
 * Get ID given message bytes
 * @param message Hex string of the packed message (see formatMessage)
 * @returns Hex string of message id
 */
export function messageId(message: HexString): HexString {
  return ethers.utils.solidityKeccak256(['bytes'], [message]);
}

/**
 * Parse a serialized Hyperlane message from raw bytes.
 *
 * @param message
 * @returns
 */
export function parseMessage(message: string): ParsedMessage {
  const VERSION_OFFSET = 0;
  const NONCE_OFFSET = 1;
  const ORIGIN_OFFSET = 5;
  const SENDER_OFFSET = 9;
  const DESTINATION_OFFSET = 41;
  const RECIPIENT_OFFSET = 45;
  const BODY_OFFSET = 77;

  const buf = Buffer.from(utils.arrayify(message));
  const version = buf.readUint8(VERSION_OFFSET);
  const nonce = buf.readUInt32BE(NONCE_OFFSET);
  const origin = buf.readUInt32BE(ORIGIN_OFFSET);
  const sender = utils.hexlify(buf.subarray(SENDER_OFFSET, DESTINATION_OFFSET));
  const destination = buf.readUInt32BE(DESTINATION_OFFSET);
  const recipient = utils.hexlify(buf.subarray(RECIPIENT_OFFSET, BODY_OFFSET));
  const body = utils.hexlify(buf.subarray(BODY_OFFSET));
  return { version, nonce, origin, sender, destination, recipient, body };
}

export function parseWarpRouteMessage(
  messageBody: string,
): ParsedWarpRouteMessage {
  const RECIPIENT_OFFSET = 0;
  const AMOUNT_OFFSET = 32;
  const buf = fromHexString(messageBody);
  const recipient = toHexString(
    buf.subarray(RECIPIENT_OFFSET, RECIPIENT_OFFSET + 32),
  );
  const amount = BigInt(
    toHexString(buf.subarray(AMOUNT_OFFSET, AMOUNT_OFFSET + 32)),
  );
  return {
    recipient,
    amount,
  };
}

// Match IGP's DEFAULT_GAS_USAGE so quote and execution use same gas
const DEFAULT_GAS_LIMIT = 50000n;

export type StandardHookMetadataParams = {
  refundAddress?: Address;
  msgValue?: bigint;
  gasLimit?: bigint;
};

/**
 * JS Implementation of solidity/contracts/hooks/libs/StandardHookMetadata.sol#formatMetadata
 * @returns Hex string of the packed hook metadata
 */
export function formatStandardHookMetadata({
  refundAddress = ethers.constants.AddressZero,
  msgValue = 0n,
  gasLimit = DEFAULT_GAS_LIMIT,
}: StandardHookMetadataParams): HexString {
  return ethers.utils.solidityPack(
    ['uint16', 'uint256', 'uint256', 'address'],
    [1, msgValue, gasLimit, refundAddress],
  );
}

export function extractRefundAddressFromMetadata(
  metadata?: HexString,
): Address | null {
  if (!metadata || metadata === '0x') return null;
  if (!/^0x[0-9a-fA-F]*$/.test(metadata)) return null;
  if (!metadata.startsWith('0x0001')) return null;

  const HEX_PREFIX_LEN = 2;
  const VARIANT_HEX_LEN = 4;
  const UINT256_HEX_LEN = 64;
  const ADDRESS_HEX_LEN = 40;
  const REFUND_START = HEX_PREFIX_LEN + VARIANT_HEX_LEN + UINT256_HEX_LEN * 2;
  const REFUND_END = REFUND_START + ADDRESS_HEX_LEN;
  if (metadata.length < REFUND_END) return null;

  const refundHex = '0x' + metadata.slice(REFUND_START, REFUND_END);
  try {
    return ethers.utils.getAddress(refundHex);
  } catch {
    return null;
  }
}

export function hasValidRefundAddress(metadata?: HexString): boolean {
  const refundAddress = extractRefundAddressFromMetadata(metadata);
  return (
    refundAddress !== null &&
    refundAddress.toLowerCase() !== ethers.constants.AddressZero
  );
}
