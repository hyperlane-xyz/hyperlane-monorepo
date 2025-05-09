import { ethers } from 'ethers';
import { Uint256, num, uint256 } from 'starknet';

import { ParsedMessage, ProtocolType } from '@hyperlane-xyz/utils';

import { DispatchedMessage } from '../core/types.js';

export function formatEthereumMessageForStarknet(message: DispatchedMessage): {
  version: number;
  nonce: number;
  origin: number;
  sender: Uint256;
  destination: number;
  recipient: Uint256;
  body: { size: number; data: bigint[] };
} {
  const sender = uint256.bnToUint256(message.parsed.sender);
  const recipient = uint256.bnToUint256(message.parsed.recipient);

  // Rest of the code remains the same
  const messageArray = ethers.utils.arrayify(message.message);
  const version = messageArray[0];
  const nonce = message.parsed.nonce;
  const origin = message.parsed.origin;
  const destination = message.parsed.destination;
  const body = messageArray.slice(77);

  return {
    version,
    nonce,
    origin,
    sender,
    destination,
    recipient,
    body: toStarknetMessageBytes(body),
  };
}

export function formatParsedStarknetMessageForEthereum(message: {
  version: number;
  nonce: number;
  origin: number;
  sender: Uint256;
  destination: number;
  recipient: Uint256;
  body: { size: number; data: bigint[] };
}): DispatchedMessage['parsed'] {
  const sender = uint256.uint256ToBN(message.sender).toString();
  const recipient = uint256.uint256ToBN(message.recipient).toString();

  const nonce = message.nonce;
  const origin = message.origin;
  const destination = message.destination;

  return {
    version: message.version,
    nonce,
    origin,
    sender: '0x' + sender,
    destination,
    recipient: '0x' + recipient,
    body: '0x',
  };
}

export function formatStarknetMessageForEthereum(
  starknetMessage: ParsedMessage & {
    body: { size: bigint; data: bigint[] };
  },
): Uint8Array {
  const VERSION_OFFSET = 0;
  const NONCE_OFFSET = 1;
  const ORIGIN_OFFSET = 5;
  const SENDER_OFFSET = 9;
  const DESTINATION_OFFSET = 41;
  const RECIPIENT_OFFSET = 45;
  const BODY_OFFSET = 77;

  const bodyBytes = convertU128ArrayToBytes(starknetMessage.body.data);
  const buffer = new Uint8Array(BODY_OFFSET + bodyBytes.length);
  const view = new DataView(buffer.buffer);
  buffer[VERSION_OFFSET] = Number(starknetMessage.version);
  view.setUint32(NONCE_OFFSET, Number(starknetMessage.nonce), false);
  view.setUint32(ORIGIN_OFFSET, Number(starknetMessage.origin), false);
  const senderValue =
    typeof starknetMessage.sender === 'string'
      ? BigInt(starknetMessage.sender)
      : starknetMessage.sender;
  const senderBytes = num.hexToBytes(num.toHex64(senderValue));
  buffer.set(senderBytes, SENDER_OFFSET);
  view.setUint32(
    DESTINATION_OFFSET,
    Number(starknetMessage.destination),
    false,
  );
  const recipientValue =
    typeof starknetMessage.recipient === 'string'
      ? BigInt(starknetMessage.recipient)
      : starknetMessage.recipient;
  const recipientBytes = num.hexToBytes(num.toHex64(recipientValue));
  buffer.set(recipientBytes, RECIPIENT_OFFSET);
  buffer.set(bodyBytes, BODY_OFFSET);
  return buffer;
}

/**
 * Convert a byte array to a starknet message
 * Pads the bytes to 16 bytes chunks
 * @param bytes Input byte array
 * @returns Object containing size and padded data array
 */
export function toStarknetMessageBytes(bytes: Uint8Array): {
  size: number;
  data: bigint[];
} {
  // Calculate the required padding
  const padding = (16 - (bytes.length % 16)) % 16;
  const totalLen = bytes.length + padding;

  // Create a new byte array with the necessary padding
  const paddedBytes = new Uint8Array(totalLen);
  paddedBytes.set(bytes);
  // Padding remains as zeros by default in Uint8Array

  // Convert to chunks of 16 bytes
  const result: bigint[] = [];
  for (let i = 0; i < totalLen; i += 16) {
    const chunk = paddedBytes.slice(i, i + 16);
    // Convert chunk to bigint (equivalent to u128 in Rust)
    const value = BigInt('0x' + Buffer.from(chunk).toString('hex'));
    result.push(value);
  }

  return {
    size: bytes.length,
    data: result,
  };
}

/**
 * Convert vector of u128 to bytes
 */
export function convertU128ArrayToBytes(input: bigint[]): Uint8Array {
  const output = new Uint8Array(input.length * 16); // Each u128 takes 16 bytes
  input.forEach((value, index) => {
    const hex = num.toHex(value);
    // Remove '0x' prefix, pad to 32 chars, then add '0x' back
    const paddedHex = '0x' + hex.replace('0x', '').padStart(32, '0');
    const bytes = num.hexToBytes(paddedHex);
    output.set(bytes, index * 16);
  });
  return output;
}

type TranslatorFn = (message: DispatchedMessage) => any;

const translators: Partial<
  Record<ProtocolType, Partial<Record<ProtocolType, TranslatorFn>>>
> = {
  [ProtocolType.Ethereum]: {
    [ProtocolType.Ethereum]: (message) => message.message,
    [ProtocolType.Starknet]: (message) =>
      formatEthereumMessageForStarknet(message),
  },
  [ProtocolType.Starknet]: {
    [ProtocolType.Ethereum]: (message) =>
      formatStarknetMessageForEthereum(message.parsed as any),
    [ProtocolType.Starknet]: (message) => message.message,
  },
};

export function translateMessage(
  message: DispatchedMessage,
  originProtocol: ProtocolType,
  destinationProtocol: ProtocolType,
) {
  const translator = translators[originProtocol]?.[destinationProtocol];
  if (!translator) {
    throw new Error(
      `No translator found for ${originProtocol} -> ${destinationProtocol}`,
    );
  }
  return translator(message);
}

type MetadataFn = () => any;

const metadataHandlers: Partial<Record<ProtocolType, MetadataFn>> = {
  [ProtocolType.Ethereum]: () => '0x0001',
  [ProtocolType.Starknet]: () => ({ size: 0, data: [] }),
};

export function getMessageMetadata(destinationProtocol: ProtocolType): any {
  const handler = metadataHandlers[destinationProtocol];
  if (!handler) {
    throw new Error(`No metadata handler for ${destinationProtocol}`);
  }
  return handler();
}
