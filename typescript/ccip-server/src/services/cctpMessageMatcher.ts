import { ethers } from 'ethers';

// Circle message header lengths differ by CCTP version:
//   CCTP V1 (MessageTransmitter)   header = 116 bytes
//   CCTP V2 (MessageTransmitterV2) header = 148 bytes
// The BurnMessage / GMP body that follows the header has the same field layout
// in both versions, so we match against BOTH header lengths rather than trusting
// the on-wire version field. This lets multi-message V1 transactions match too.
const CIRCLE_HEADER_LENGTH_V1 = 116;
const CIRCLE_HEADER_LENGTH_V2 = 148;
const CIRCLE_HEADER_LENGTHS = [
  CIRCLE_HEADER_LENGTH_V1,
  CIRCLE_HEADER_LENGTH_V2,
];
const CIRCLE_V1_NONCE_OFFSET = 12;
const CIRCLE_V1_NONCE_LENGTH = 8;

// BurnMessage body field offsets, relative to the end of the Circle header:
// version(4) burnToken(32) mintRecipient(32) amount(32) messageSender(32) ...
const BURN_MSG_MINT_RECIPIENT_OFFSET = 36;
const BURN_MSG_AMOUNT_OFFSET = 68;
const BURN_MSG_SENDER_OFFSET = 100;
const BURN_MSG_BODY_MIN_LENGTH = 132; // through messageSender

// Backwards-compatible absolute offsets within a CctpMessageV2 (header = 148).
export const CIRCLE_MINT_RECIPIENT_OFFSET =
  CIRCLE_HEADER_LENGTH_V2 + BURN_MSG_MINT_RECIPIENT_OFFSET; // 184
export const CIRCLE_AMOUNT_OFFSET =
  CIRCLE_HEADER_LENGTH_V2 + BURN_MSG_AMOUNT_OFFSET; // 216
export const CIRCLE_SENDER_OFFSET =
  CIRCLE_HEADER_LENGTH_V2 + BURN_MSG_SENDER_OFFSET; // 248

// Circle GMP message body = abi.encode(messageId) = the trailing 32 bytes after
// the header. So V1 GMP messages are 148 bytes and V2 GMP messages are 180 bytes.
const CIRCLE_GMP_BODY_LENGTH = 32;
const CIRCLE_GMP_MSG_LENGTHS = CIRCLE_HEADER_LENGTHS.map(
  (h) => h + CIRCLE_GMP_BODY_LENGTH,
); // [148, 180]

// TokenMessage body layout (Hyperlane warp route):
// recipient(32) amount(32) [metadata...]
const TOKEN_MSG_RECIPIENT_OFFSET = 0;
const TOKEN_MSG_AMOUNT_OFFSET = 32;
const TOKEN_MSG_MIN_LENGTH = 64;
const TOKEN_MSG_METADATA_OFFSET = 64;

/**
 * Given a list of raw Circle message hex strings from a transaction receipt,
 * return the one that corresponds to the given Hyperlane message.
 *
 * Strategy 1 — token transfer (depositForBurn path):
 *   Matches by (messageSender, amount, mintRecipient) from the Hyperlane message
 *   against BurnMessage fields, mirroring TokenBridgeCctp._validateTokenMessage.
 *   Legacy V1 token messages include the Circle uint64 nonce as the first 8
 *   metadata bytes; when present, it also disambiguates otherwise-identical burns.
 *   Tries both the CCTP V1 (116B) and V2 (148B) header lengths, so a V1 burn
 *   message (≥ 248 bytes) matches under V1 and a V2 burn (≥ 280) under V2.
 *
 * Strategy 2 — GMP hook path (sendMessageIdToIsm):
 *   The Circle message body is abi.encode(messageId) — the trailing 32 bytes.
 *   V1 GMP messages are 148 bytes and V2 GMP messages are 180 bytes.
 *
 * Returns null if neither strategy finds a match.
 */
export function findMatchingCircleMessage(
  circleMessages: string[],
  hyperlaneBody: Uint8Array,
  messageId: string,
  hyperlaneSender: string,
): string | null {
  if (circleMessages.length === 1) return circleMessages[0];

  // Strategy 1: token transfer — match by (messageSender, amount, mintRecipient),
  // mirroring the three-field check in TokenBridgeCctp._validateTokenMessage.
  if (hyperlaneBody.length >= TOKEN_MSG_MIN_LENGTH) {
    const hlRecipient = hyperlaneBody.slice(
      TOKEN_MSG_RECIPIENT_OFFSET,
      TOKEN_MSG_RECIPIENT_OFFSET + 32,
    );
    const hlAmount = hyperlaneBody.slice(
      TOKEN_MSG_AMOUNT_OFFSET,
      TOKEN_MSG_AMOUNT_OFFSET + 32,
    );
    const hlV1Nonce =
      hyperlaneBody.length >= TOKEN_MSG_METADATA_OFFSET + CIRCLE_V1_NONCE_LENGTH
        ? hyperlaneBody.slice(
            TOKEN_MSG_METADATA_OFFSET,
            TOKEN_MSG_METADATA_OFFSET + CIRCLE_V1_NONCE_LENGTH,
          )
        : undefined;
    const hlSenderBytes = ethers.utils.arrayify(hyperlaneSender);

    for (const msg of circleMessages) {
      const bytes = ethers.utils.arrayify(msg);

      for (const header of CIRCLE_HEADER_LENGTHS) {
        if (bytes.length < header + BURN_MSG_BODY_MIN_LENGTH) continue;

        const mintRecipient = bytes.slice(
          header + BURN_MSG_MINT_RECIPIENT_OFFSET,
          header + BURN_MSG_MINT_RECIPIENT_OFFSET + 32,
        );
        const amount = bytes.slice(
          header + BURN_MSG_AMOUNT_OFFSET,
          header + BURN_MSG_AMOUNT_OFFSET + 32,
        );
        const circleSender = bytes.slice(
          header + BURN_MSG_SENDER_OFFSET,
          header + BURN_MSG_SENDER_OFFSET + 32,
        );
        const circleV1Nonce = bytes.slice(
          CIRCLE_V1_NONCE_OFFSET,
          CIRCLE_V1_NONCE_OFFSET + CIRCLE_V1_NONCE_LENGTH,
        );

        if (
          Buffer.from(circleSender).equals(Buffer.from(hlSenderBytes)) &&
          Buffer.from(mintRecipient).equals(Buffer.from(hlRecipient)) &&
          Buffer.from(amount).equals(Buffer.from(hlAmount)) &&
          (header !== CIRCLE_HEADER_LENGTH_V1 ||
            hlV1Nonce === undefined ||
            Buffer.from(circleV1Nonce).equals(Buffer.from(hlV1Nonce)))
        ) {
          return msg;
        }
      }
    }
  }

  // Strategy 2: GMP — match by messageId in the trailing 32 bytes of the body.
  const messageIdBytes = ethers.utils.arrayify(messageId);
  for (const msg of circleMessages) {
    const bytes = ethers.utils.arrayify(msg);
    if (!CIRCLE_GMP_MSG_LENGTHS.includes(bytes.length)) continue;

    const circleBodyId = bytes.slice(
      bytes.length - CIRCLE_GMP_BODY_LENGTH,
      bytes.length,
    );
    if (Buffer.from(circleBodyId).equals(Buffer.from(messageIdBytes))) {
      return msg;
    }
  }

  return null;
}
