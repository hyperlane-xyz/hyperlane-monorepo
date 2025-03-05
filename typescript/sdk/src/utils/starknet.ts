import { utils } from 'ethers';
import {
  Account,
  CairoOption,
  CairoOptionVariant,
  Contract,
  ParsedEvent,
  ParsedEvents,
  ParsedStruct,
  Provider,
} from 'starknet';

import {
  ContractType,
  getCompiledContract,
} from '@hyperlane-xyz/starknet-core';

import { DispatchedMessage } from '../core/types.js';

export function getStarknetMailboxContract(
  address: string,
  signer: Account | Provider,
): Contract {
  const { abi } = getCompiledContract('mailbox');
  return new Contract(abi, address, signer);
}

export function getStarknetHypERC20Contract(
  address: string,
  signer?: Account | Provider,
): Contract {
  const { abi } = getCompiledContract('HypErc20', ContractType.TOKEN);
  return new Contract(abi, address, signer);
}

export function getStarknetHypERC20CollateralContract(
  address: string,
  signer?: Account | Provider,
): Contract {
  const { abi } = getCompiledContract('HypErc20Collateral', ContractType.TOKEN);
  return new Contract(abi, address, signer);
}

export function getStarknetHypNativeContract(
  address: string,
  signer?: Account | Provider,
): Contract {
  const { abi } = getCompiledContract('HypNative', ContractType.TOKEN);
  return new Contract(abi, address, signer);
}

const DISPATCH_EVENT = 'contracts::mailbox::mailbox::Dispatch';

export function parseStarknetDispatchedMessages(
  parsedEvents: ParsedEvents,
  chainNameResolver: (domain: number) => string | undefined,
): DispatchedMessage[] {
  return parsedEvents
    .filter((event: ParsedEvent) => DISPATCH_EVENT in event)
    .map((dispatchEvent: ParsedEvent) => {
      const message = dispatchEvent[DISPATCH_EVENT].message as ParsedStruct;

      const originChain = chainNameResolver(Number(message.origin));
      const destinationChain = chainNameResolver(Number(message.destination));

      const messageId = getStarknetMessageId(message as unknown as Message);

      return {
        parsed: {
          ...message,
          originChain,
          destinationChain,
        },
        id: messageId.toString(),
        message: message.raw,
      } as DispatchedMessage;
    });
}

export async function quoteStarknetDispatch({
  mailboxContract,
  destinationDomain,
  recipientAddress,
  messageBody,
  customHookMetadata,
  customHook,
}: {
  mailboxContract: Contract;
  destinationDomain: number;
  recipientAddress: string;
  messageBody: {
    size: number;
    data: bigint[];
  };
  customHookMetadata?: string;
  customHook?: string;
}): Promise<string> {
  const nonOption = new CairoOption(CairoOptionVariant.None);

  const quote = await mailboxContract.call('quote_dispatch', [
    destinationDomain,
    recipientAddress,
    messageBody,
    customHookMetadata || nonOption,
    customHook || nonOption,
  ]);

  return quote.toString();
}

export interface Message {
  version: number;
  nonce: number;
  origin: number;
  sender: bigint;
  destination: number;
  recipient: bigint;
  body: { size: bigint; data: bigint[] };
}

export interface ByteData {
  value: bigint;
  size: number;
}

export function getStarknetMessageId(message: Message): bigint {
  const input: ByteData[] = [
    { value: BigInt(message.version), size: 1 },
    { value: BigInt(message.nonce), size: 4 },
    { value: BigInt(message.origin), size: 4 },
    { value: message.sender, size: 32 },
    { value: BigInt(message.destination), size: 4 },
    { value: message.recipient, size: 32 },
  ];

  // Append message body
  const serializedInput = serializeByteData(input, message.body);

  const hash = utils.keccak256(serializedInput);

  // Convert hash to BigInt and reverse endianness
  return reverseEndianness(BigInt(hash));
}

/**
 * Helper function to serialize ByteData array and message body into a single buffer
 */
function serializeByteData(
  input: ByteData[],
  body: { size: bigint; data: bigint[] },
): Uint8Array {
  // Calculate total size
  const bodySize = Number(body.size);
  let totalSize = input.reduce((acc, item) => acc + item.size, 0) + bodySize;

  // Create buffer
  const buffer = Buffer.alloc(totalSize);
  let offset = 0;

  // Serialize each ByteData item
  for (const item of input) {
    serializeToBuffer(item.value, item.size, buffer, offset);
    offset += item.size;
  }

  // Add message body data
  serializeBodyData(body.data, bodySize, buffer, offset);

  return buffer;
}

/**
 * Helper function to serialize message body data to buffer
 */
function serializeBodyData(
  data: bigint[],
  size: number,
  buffer: Buffer,
  offset: number,
): void {
  let currentOffset = offset;

  // The body.data is an array of bigints (u128 in Cairo)
  // Each bigint can represent up to 16 bytes (128 bits)
  for (let i = 0; i < data.length; i++) {
    const value = data[i];
    const remainingSize = size - (currentOffset - offset);

    // If we have processed all the bytes required by size, break out
    if (remainingSize <= 0) break;

    // Calculate how many bytes to take from this bigint
    // Either 16 bytes (full u128) or the remaining bytes needed
    const bytesToTake = Math.min(16, remainingSize);

    serializeToBuffer(value, bytesToTake, buffer, currentOffset);
    currentOffset += bytesToTake;
  }
}

/**
 * Helper function to serialize a single value to buffer at the given offset
 */
function serializeToBuffer(
  value: bigint,
  size: number,
  buffer: Buffer,
  offset: number,
): void {
  if (size <= 0 || offset < 0 || offset + size > buffer.length) {
    throw new Error(
      `Invalid buffer parameters: size=${size}, offset=${offset}, bufferLength=${buffer.length}`,
    );
  }

  for (let i = 0; i < size; i++) {
    // Extract each byte, most significant byte first (big-endian)
    const bytePosition = size - 1 - i;
    const byteValue = Number(
      (value >> BigInt(bytePosition * 8)) & BigInt(0xff),
    );
    buffer[offset + i] = byteValue;
  }
}

/**
 * Reverses the endianness of a bigint (u256 equivalent)
 */
function reverseEndianness(value: bigint): bigint {
  let result = BigInt(0);
  let input = value;

  // Process 32 bytes (256 bits)
  for (let i = 0; i < 32; i++) {
    const byte = input & BigInt(0xff);
    result = (result << BigInt(8)) | byte;
    input = input >> BigInt(8);
  }

  return result;
}
