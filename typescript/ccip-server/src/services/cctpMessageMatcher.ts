import { ethers } from 'ethers';

// CctpMessageV2 + BurnMessageV2 field offsets within the full Circle message.
// CctpMessageV2 header is 148 bytes; BurnMessageV2 body follows immediately.
// BurnMessageV2: version(4) burnToken(32) mintRecipient(32) amount(32) ...
const CIRCLE_HEADER_LENGTH = 148;
const BURN_MSG_MINT_RECIPIENT_OFFSET = 36; // within BurnMessageV2 body
const BURN_MSG_AMOUNT_OFFSET = 68; // within BurnMessageV2 body
export const CIRCLE_MINT_RECIPIENT_OFFSET =
  CIRCLE_HEADER_LENGTH + BURN_MSG_MINT_RECIPIENT_OFFSET; // 184
export const CIRCLE_AMOUNT_OFFSET =
  CIRCLE_HEADER_LENGTH + BURN_MSG_AMOUNT_OFFSET; // 216
const CIRCLE_BURN_MSG_MIN_LENGTH = CIRCLE_AMOUNT_OFFSET + 32; // 248

// Circle GMP message body = abi.encode(messageId) = 32 bytes starting at header end.
const CIRCLE_GMP_BODY_OFFSET = CIRCLE_HEADER_LENGTH; // 148
const CIRCLE_GMP_MSG_LENGTH = CIRCLE_HEADER_LENGTH + 32; // 180

// TokenMessage body layout (Hyperlane warp route):
// recipient(32) amount(32) [metadata...]
const TOKEN_MSG_RECIPIENT_OFFSET = 0;
const TOKEN_MSG_AMOUNT_OFFSET = 32;
const TOKEN_MSG_MIN_LENGTH = 64;

/**
 * Given a list of raw Circle message hex strings from a transaction receipt,
 * return the one that corresponds to the given Hyperlane message.
 *
 * Strategy 1 — token transfer (depositForBurn path):
 *   Matches by (mintRecipient, amount) from the Hyperlane TokenMessage body
 *   against BurnMessageV2 fields. Circle burn messages are ≥ 248 bytes.
 *
 * Strategy 2 — GMP hook path (sendMessageIdToIsm):
 *   The Circle message body is abi.encode(messageId) = the 32-byte Hyperlane
 *   message ID at offset 148. Circle GMP messages are exactly 180 bytes.
 *
 * Falls back to circleMessages[0] if neither strategy finds a match.
 */
export function findMatchingCircleMessage(
  circleMessages: string[],
  hyperlaneBody: Uint8Array,
  messageId: string,
): string {
  if (circleMessages.length === 1) return circleMessages[0];

  // Strategy 1: token transfer — match by (mintRecipient, amount)
  if (hyperlaneBody.length >= TOKEN_MSG_MIN_LENGTH) {
    const hlRecipient = hyperlaneBody.slice(
      TOKEN_MSG_RECIPIENT_OFFSET,
      TOKEN_MSG_RECIPIENT_OFFSET + 32,
    );
    const hlAmount = hyperlaneBody.slice(
      TOKEN_MSG_AMOUNT_OFFSET,
      TOKEN_MSG_AMOUNT_OFFSET + 32,
    );

    for (const msg of circleMessages) {
      const bytes = ethers.utils.arrayify(msg);
      if (bytes.length < CIRCLE_BURN_MSG_MIN_LENGTH) continue;

      const mintRecipient = bytes.slice(
        CIRCLE_MINT_RECIPIENT_OFFSET,
        CIRCLE_MINT_RECIPIENT_OFFSET + 32,
      );
      const amount = bytes.slice(
        CIRCLE_AMOUNT_OFFSET,
        CIRCLE_AMOUNT_OFFSET + 32,
      );

      if (
        Buffer.from(mintRecipient).equals(Buffer.from(hlRecipient)) &&
        Buffer.from(amount).equals(Buffer.from(hlAmount))
      ) {
        return msg;
      }
    }
  }

  // Strategy 2: GMP — match by messageId in Circle message body
  const messageIdBytes = ethers.utils.arrayify(messageId);
  for (const msg of circleMessages) {
    const bytes = ethers.utils.arrayify(msg);
    if (bytes.length < CIRCLE_GMP_MSG_LENGTH) continue;

    const circleBodyId = bytes.slice(
      CIRCLE_GMP_BODY_OFFSET,
      CIRCLE_GMP_BODY_OFFSET + 32,
    );
    if (Buffer.from(circleBodyId).equals(Buffer.from(messageIdBytes))) {
      return msg;
    }
  }

  return circleMessages[0];
}
