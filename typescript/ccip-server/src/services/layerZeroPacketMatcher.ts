import { ethers } from 'ethers';

import { Mailbox__factory } from '@hyperlane-xyz/core';
import { assert } from '@hyperlane-xyz/utils';

export const LAYER_ZERO_PACKET_VERSION = 1;
export const LAYER_ZERO_PACKET_HEADER_LENGTH = 81;
export const LAYER_ZERO_PACKET_MESSAGE_OFFSET = 113;

const PACKET_SENT_ABI = [
  'event PacketSent(bytes encodedPayload, bytes options, address sendLibrary)',
];

export interface LayerZeroPacketQuery {
  endpoint: string;
  sourceEid: number;
  destinationEid: number;
  sender: string;
  receiver: string;
  payload: string;
}

export function countMatchingHyperlaneDispatches(
  logs: ReadonlyArray<{ address: string; topics: Array<string>; data: string }>,
  mailboxAddress: string,
  message: string,
): number {
  const mailbox = Mailbox__factory.createInterface();
  return logs.filter((log) => {
    if (log.address.toLowerCase() !== mailboxAddress.toLowerCase())
      return false;
    try {
      const parsedLog = mailbox.parseLog(log);
      return (
        parsedLog.name === 'Dispatch' &&
        parsedLog.args.message.toLowerCase() === message.toLowerCase()
      );
    } catch {
      return false;
    }
  }).length;
}

export interface ParsedLayerZeroPacket {
  packet: string;
  nonce: bigint;
  sourceEid: number;
  sender: string;
  destinationEid: number;
  receiver: string;
  guid: string;
  payload: string;
  header: string;
  payloadHash: string;
  sendLibrary: string;
}

export interface LayerZeroEndpointReader {
  getReceiveLibrary(
    receiver: string,
    srcEid: number,
  ): Promise<[string, boolean]>;
  receiveLibraryTimeout(
    receiver: string,
    srcEid: number,
  ): Promise<[string, ethers.BigNumberish]>;
  inboundPayloadHash(
    receiver: string,
    srcEid: number,
    sender: string,
    nonce: ethers.BigNumberish,
  ): Promise<string>;
  isValidReceiveLibrary(
    receiver: string,
    srcEid: number,
    library: string,
  ): Promise<boolean>;
}

export interface LayerZeroReceiveQuery {
  receiver: string;
  sourceEid: number;
  sender: string;
  nonce: ethers.BigNumberish;
  payloadHash: string;
}

export async function resolveLayerZeroReceiveLibrary(
  endpoint: LayerZeroEndpointReader,
  query: LayerZeroReceiveQuery,
  simulateCommit: (library: string) => Promise<void>,
): Promise<string> {
  const [current, timeout, currentPayloadHash] = await Promise.all([
    endpoint.getReceiveLibrary(query.receiver, query.sourceEid),
    endpoint.receiveLibraryTimeout(query.receiver, query.sourceEid),
    endpoint.inboundPayloadHash(
      query.receiver,
      query.sourceEid,
      query.sender,
      query.nonce,
    ),
  ]);
  const candidates = [...new Set<string>([current[0], timeout[0]])].filter(
    (library) =>
      library.toLowerCase() !== ethers.constants.AddressZero.toLowerCase(),
  );
  const validCandidates: string[] = [];
  for (const library of candidates) {
    if (
      await endpoint.isValidReceiveLibrary(
        query.receiver,
        query.sourceEid,
        library,
      )
    ) {
      validCandidates.push(library);
    }
  }
  assert(validCandidates.length > 0, 'No valid LayerZero receive library');

  if (currentPayloadHash !== ethers.constants.HashZero) {
    assert(
      currentPayloadHash.toLowerCase() === query.payloadHash.toLowerCase(),
      'Endpoint contains a conflicting LayerZero payload hash',
    );
    return validCandidates[0];
  }

  let lastError: unknown;
  for (const library of validCandidates) {
    try {
      await simulateCommit(library);
      return library;
    } catch (error) {
      lastError = error;
      continue;
    }
  }
  throw new Error(`LayerZero packet is not DVN-ready: ${lastError}`);
}

export function encodeLayerZeroPayload(
  origin: number,
  destination: number,
  messageId: string,
): string {
  return ethers.utils.defaultAbiCoder.encode(
    ['uint8', 'uint32', 'uint32', 'bytes32'],
    [1, origin, destination, messageId],
  );
}

export function parseLayerZeroPacket(packet: string): ParsedLayerZeroPacket {
  const bytes = ethers.utils.arrayify(packet);
  assert(
    bytes.length >= LAYER_ZERO_PACKET_MESSAGE_OFFSET,
    'LayerZero packet is truncated',
  );
  assert(
    bytes[0] === LAYER_ZERO_PACKET_VERSION,
    `Unsupported LayerZero packet version ${bytes[0]}`,
  );

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nonce = view.getBigUint64(1);
  const sourceEid = view.getUint32(9);
  const sender = ethers.utils.hexlify(bytes.subarray(13, 45));
  const destinationEid = view.getUint32(45);
  const receiver = ethers.utils.hexlify(bytes.subarray(49, 81));
  const guid = ethers.utils.hexlify(bytes.subarray(81, 113));
  const payload = ethers.utils.hexlify(bytes.subarray(113));
  const header = ethers.utils.hexlify(bytes.subarray(0, 81));
  const expectedGuid = ethers.utils.solidityKeccak256(
    ['uint64', 'uint32', 'bytes32', 'uint32', 'bytes32'],
    [nonce.toString(), sourceEid, sender, destinationEid, receiver],
  );
  assert(
    guid.toLowerCase() === expectedGuid.toLowerCase(),
    'LayerZero GUID mismatch',
  );

  return {
    packet,
    nonce,
    sourceEid,
    sender,
    destinationEid,
    receiver,
    guid,
    payload,
    header,
    payloadHash: ethers.utils.keccak256(
      ethers.utils.hexConcat([guid, payload]),
    ),
    sendLibrary: ethers.constants.AddressZero,
  };
}

export function findMatchingLayerZeroPacket(
  logs: ReadonlyArray<{ address: string; topics: Array<string>; data: string }>,
  query: LayerZeroPacketQuery,
): ParsedLayerZeroPacket {
  const iface = new ethers.utils.Interface(PACKET_SENT_ABI);
  const matches: ParsedLayerZeroPacket[] = [];

  for (const log of logs) {
    if (log.address.toLowerCase() !== query.endpoint.toLowerCase()) continue;
    let decoded;
    try {
      decoded = iface.parseLog(log);
    } catch {
      continue;
    }
    if (decoded.name !== 'PacketSent') continue;

    let packet: ParsedLayerZeroPacket;
    try {
      packet = parseLayerZeroPacket(decoded.args.encodedPayload);
    } catch {
      continue;
    }
    if (
      packet.sourceEid !== query.sourceEid ||
      packet.destinationEid !== query.destinationEid ||
      packet.sender.toLowerCase() !== query.sender.toLowerCase() ||
      packet.receiver.toLowerCase() !== query.receiver.toLowerCase() ||
      packet.payload.toLowerCase() !== query.payload.toLowerCase()
    ) {
      continue;
    }
    matches.push({ ...packet, sendLibrary: decoded.args.sendLibrary });
  }

  assert(matches.length > 0, 'No matching LayerZero packet in origin receipt');
  assert(matches.length === 1, 'Ambiguous LayerZero packets in origin receipt');
  return matches[0];
}
