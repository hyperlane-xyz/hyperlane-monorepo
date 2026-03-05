import { BigNumber } from 'bignumber.js';
import { Hex, concat, encodePacked, hexToBytes, toHex } from 'viem';

import { addressToBytes32 } from './addresses.js';
import { ParsedLegacyMultisigIsmMetadata } from './types.js';

export const parseLegacyMultisigIsmMetadata = (
  metadata: string,
): ParsedLegacyMultisigIsmMetadata => {
  const MERKLE_ROOT_OFFSET = 0;
  const MERKLE_INDEX_OFFSET = 32;
  const ORIGIN_MAILBOX_OFFSET = 36;
  const MERKLE_PROOF_OFFSET = 68;
  const THRESHOLD_OFFSET = 1092;
  const SIGNATURES_OFFSET = 1093;
  const SIGNATURE_LENGTH = 65;

  const buf = Buffer.from(hexToBytes(metadata as Hex));
  const checkpointRoot = toHex(
    buf.slice(MERKLE_ROOT_OFFSET, MERKLE_INDEX_OFFSET),
  );
  const checkpointIndex = BigNumber(
    toHex(buf.slice(MERKLE_INDEX_OFFSET, ORIGIN_MAILBOX_OFFSET)),
  ).toNumber();
  const originMailbox = toHex(
    buf.slice(ORIGIN_MAILBOX_OFFSET, MERKLE_PROOF_OFFSET),
  );
  const parseBytesArray = (start: number, count: number, size: number) => {
    return [...Array(count).keys()].map((i) =>
      toHex(buf.slice(start + size * i, start + size * (i + 1))),
    );
  };
  const proof = parseBytesArray(MERKLE_PROOF_OFFSET, 32, 32);
  const threshold = BigNumber(
    toHex(buf.slice(THRESHOLD_OFFSET, SIGNATURES_OFFSET)),
  ).toNumber();
  const signatures = parseBytesArray(
    SIGNATURES_OFFSET,
    threshold,
    SIGNATURE_LENGTH,
  );
  const VALIDATORS_OFFSET = SIGNATURES_OFFSET + threshold * SIGNATURE_LENGTH;
  const addressesCount = buf.slice(VALIDATORS_OFFSET).length / 32;
  const validators = parseBytesArray(VALIDATORS_OFFSET, addressesCount, 32);
  return {
    checkpointRoot,
    checkpointIndex,
    originMailbox,
    proof,
    signatures,
    validators,
  };
};

export const formatLegacyMultisigIsmMetadata = (
  metadata: ParsedLegacyMultisigIsmMetadata,
): string => {
  const abiTypes = [
    'bytes32',
    'uint32',
    'bytes32',
    'bytes32[32]',
    'uint8',
    'bytes',
    'address[]',
  ] as const;
  const abiValues = [
    metadata.checkpointRoot as Hex,
    metadata.checkpointIndex,
    addressToBytes32(metadata.originMailbox) as Hex,
    metadata.proof as readonly Hex[],
    metadata.signatures.length,
    concat(metadata.signatures as readonly Hex[]),
    metadata.validators as readonly `0x${string}`[],
  ] as const;

  return encodePacked(
    abiTypes as unknown as readonly string[],
    abiValues as unknown as readonly unknown[],
  );
};
