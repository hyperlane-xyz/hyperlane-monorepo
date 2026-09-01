import { ethers } from 'ethers';

import { assert } from '@hyperlane-xyz/utils';

/**
 * Wire helpers for the Wormhole hook/ISM routers.
 *
 * Everything here is pure: payload encoding, receipt-log disambiguation, and
 * VAA parsing. The CCIP-read service is untrusted transport, so each of these
 * checks is re-applied by `AbstractWormholeHookIsm` on chain. They exist here so
 * the service fails fast and loudly instead of returning a VAA the destination
 * would reject.
 */

/** `bytes4(keccak256("HYPERLANE_WORMHOLE"))`, matching `WormholeMessage.MAGIC`. */
export const WORMHOLE_PAYLOAD_MAGIC = ethers.utils.hexDataSlice(
  ethers.utils.id('HYPERLANE_WORMHOLE'),
  0,
  4,
);

export const WORMHOLE_PAYLOAD_VERSION = 1;

/** `abi.encode` of seven static fields. */
export const WORMHOLE_PAYLOAD_LENGTH = 32 * 7;

const PAYLOAD_ABI = [
  'tuple(bytes4 magic, uint8 version, uint32 originDomain, uint32 destinationDomain, bytes32 destinationRouter, bytes32 messageId, uint32 nonce)',
];

/** Wormhole Core's publication event, used to locate the emitted payload. */
export const LOG_MESSAGE_PUBLISHED_ABI = [
  'event LogMessagePublished(address indexed sender, uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel)',
];

export interface WormholePayload {
  magic: string;
  version: number;
  originDomain: number;
  destinationDomain: number;
  destinationRouter: string;
  messageId: string;
  nonce: number;
}

export interface WormholePublication {
  sender: string;
  sequence: string;
  nonce: number;
  payload: string;
  consistencyLevel: number;
  payloadFields: WormholePayload;
}

export interface ParsedVaa {
  version: number;
  guardianSetIndex: number;
  signatureCount: number;
  timestamp: number;
  nonce: number;
  emitterChainId: number;
  emitterAddress: string;
  sequence: string;
  consistencyLevel: number;
  payload: string;
}

export function encodeWormholePayload(payload: WormholePayload): string {
  return ethers.utils.defaultAbiCoder.encode(PAYLOAD_ABI, [
    [
      payload.magic,
      payload.version,
      payload.originDomain,
      payload.destinationDomain,
      payload.destinationRouter,
      payload.messageId,
      payload.nonce,
    ],
  ]);
}

export function decodeWormholePayload(payload: string): WormholePayload {
  assert(
    ethers.utils.hexDataLength(payload) === WORMHOLE_PAYLOAD_LENGTH,
    `Wormhole payload must be ${WORMHOLE_PAYLOAD_LENGTH} bytes`,
  );
  const [decoded] = ethers.utils.defaultAbiCoder.decode(PAYLOAD_ABI, payload);
  assert(
    decoded.magic === WORMHOLE_PAYLOAD_MAGIC,
    'Wormhole payload magic mismatch',
  );
  assert(
    decoded.version === WORMHOLE_PAYLOAD_VERSION,
    `Unsupported Wormhole payload version ${decoded.version}`,
  );
  return {
    magic: decoded.magic,
    version: decoded.version,
    originDomain: decoded.originDomain,
    destinationDomain: decoded.destinationDomain,
    destinationRouter: decoded.destinationRouter,
    messageId: decoded.messageId,
    nonce: decoded.nonce,
  };
}

export interface PublicationQuery {
  /** Official Core proxy for the origin chain. Only its logs are inspected. */
  coreAddress: string;
  /** Enrolled origin router, as a universal `bytes32`. */
  originRouter: string;
  destinationRouter: string;
  messageId: string;
  originDomain: number;
  destinationDomain: number;
  nonce: number;
}

/**
 * Finds the single Core publication in `logs` that belongs to this Hyperlane
 * message.
 *
 * Logs from any address other than the configured Core are ignored outright, so
 * a lookalike event cannot be substituted. Zero and multiple matches are both
 * errors: the destination binds one exact VAA, so an ambiguous receipt must not
 * resolve arbitrarily.
 */
export function findMatchingWormholePublication(
  logs: ReadonlyArray<{ address: string; topics: Array<string>; data: string }>,
  query: PublicationQuery,
): WormholePublication {
  const iface = new ethers.utils.Interface(LOG_MESSAGE_PUBLISHED_ABI);
  const core = query.coreAddress.toLowerCase();
  const matches: Array<WormholePublication> = [];

  for (const log of logs) {
    if (log.address.toLowerCase() !== core) continue;

    let parsed;
    try {
      parsed = iface.parseLog(log);
    } catch {
      // A non-publication event from Core; not an error.
      continue;
    }
    if (parsed.name !== 'LogMessagePublished') continue;

    if (
      ethers.utils.hexZeroPad(parsed.args.sender, 32).toLowerCase() !==
      query.originRouter.toLowerCase()
    ) {
      continue;
    }

    let payloadFields: WormholePayload;
    try {
      payloadFields = decodeWormholePayload(parsed.args.payload);
    } catch {
      // Another Hyperlane-unrelated publication by the same emitter.
      continue;
    }

    if (
      payloadFields.messageId.toLowerCase() !== query.messageId.toLowerCase() ||
      payloadFields.originDomain !== query.originDomain ||
      payloadFields.destinationDomain !== query.destinationDomain ||
      payloadFields.nonce !== query.nonce ||
      payloadFields.destinationRouter.toLowerCase() !==
        query.destinationRouter.toLowerCase()
    ) {
      continue;
    }

    assert(
      parsed.args.nonce === query.nonce,
      'Core publication nonce does not equal the Hyperlane nonce',
    );

    matches.push({
      sender: parsed.args.sender,
      sequence: parsed.args.sequence.toString(),
      nonce: parsed.args.nonce,
      payload: parsed.args.payload,
      consistencyLevel: parsed.args.consistencyLevel,
      payloadFields,
    });
  }

  assert(
    matches.length > 0,
    `No Wormhole publication for message ${query.messageId} in this receipt`,
  );
  assert(
    matches.length === 1,
    `Ambiguous receipt: ${matches.length} Wormhole publications match message ${query.messageId}`,
  );
  return matches[0];
}

/**
 * Parses a v1 VAA.
 *
 * Signature bytes are skipped rather than verified — only destination Core can
 * verify Guardian signatures. Parsing exists so the service can re-check the
 * signed body against what the origin actually published.
 */
export function parseVaa(encodedVaa: string): ParsedVaa {
  const bytes = ethers.utils.arrayify(encodedVaa);
  assert(bytes.length >= 6, 'VAA too short for a header');

  const version = bytes[0];
  assert(version === 1, `Unsupported VAA version ${version}`);

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const guardianSetIndex = view.getUint32(1);
  const signatureCount = bytes[5];

  const SIGNATURE_LENGTH = 66; // guardianIndex(1) r(32) s(32) v(1)
  const bodyOffset = 6 + signatureCount * SIGNATURE_LENGTH;
  assert(
    bytes.length >= bodyOffset + 51,
    'VAA truncated before the end of its body header',
  );

  const timestamp = view.getUint32(bodyOffset);
  const nonce = view.getUint32(bodyOffset + 4);
  const emitterChainId = view.getUint16(bodyOffset + 8);
  const emitterAddress = ethers.utils.hexlify(
    bytes.subarray(bodyOffset + 10, bodyOffset + 42),
  );
  const sequence = ethers.BigNumber.from(
    bytes.subarray(bodyOffset + 42, bodyOffset + 50),
  ).toString();
  const consistencyLevel = bytes[bodyOffset + 50];
  const payload = ethers.utils.hexlify(bytes.subarray(bodyOffset + 51));

  return {
    version,
    guardianSetIndex,
    signatureCount,
    timestamp,
    nonce,
    emitterChainId,
    emitterAddress,
    sequence,
    consistencyLevel,
    payload,
  };
}

/**
 * Re-checks an upstream VAA against the publication observed on the origin
 * chain. Wormholescan response metadata is never trusted; only the decoded VAA
 * bytes are.
 */
export function assertVaaMatchesPublication(
  vaa: ParsedVaa,
  publication: WormholePublication,
  expected: { emitterChainId: number; originRouter: string },
): void {
  assert(
    vaa.emitterChainId === expected.emitterChainId,
    `VAA emitter chain ${vaa.emitterChainId} does not match origin ${expected.emitterChainId}`,
  );
  assert(
    vaa.emitterAddress.toLowerCase() === expected.originRouter.toLowerCase(),
    'VAA emitter is not the enrolled origin router',
  );
  assert(
    vaa.sequence === publication.sequence,
    `VAA sequence ${vaa.sequence} does not match publication ${publication.sequence}`,
  );
  assert(
    vaa.nonce === publication.nonce,
    'VAA nonce does not match the publication nonce',
  );
  assert(
    vaa.consistencyLevel === publication.consistencyLevel,
    'VAA consistency level does not match the publication',
  );
  assert(
    vaa.payload.toLowerCase() === publication.payload.toLowerCase(),
    'VAA payload does not match the published payload',
  );
}

/** `(emitterChain, emitterAddress, sequence)` — the canonical VAA locator. */
export function formatVaaId(
  emitterChainId: number,
  emitterAddress: string,
  sequence: string,
): string {
  const emitter = ethers.utils
    .hexZeroPad(emitterAddress, 32)
    .slice(2)
    .toLowerCase();
  return `${emitterChainId}/${emitter}/${sequence}`;
}
