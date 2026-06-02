import { expect } from 'chai';
import { ethers } from 'ethers';

import {
  CIRCLE_AMOUNT_OFFSET,
  CIRCLE_MINT_RECIPIENT_OFFSET,
  CIRCLE_SENDER_OFFSET,
  findMatchingCircleMessage,
} from '../../src/services/cctpMessageMatcher.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal CctpMessageV2 + BurnMessageV2 Circle message (≥ 280 bytes).
 *  Sets mintRecipient, amount, and messageSender; everything else is zeros. */
function makeBurnCircleMessage(
  mintRecipient: Uint8Array,
  amount: Uint8Array,
  sender: Uint8Array = Buffer.alloc(32, 0x00),
): string {
  const buf = Buffer.alloc(280);
  mintRecipient.forEach((b, i) => (buf[CIRCLE_MINT_RECIPIENT_OFFSET + i] = b));
  amount.forEach((b, i) => (buf[CIRCLE_AMOUNT_OFFSET + i] = b));
  sender.forEach((b, i) => (buf[CIRCLE_SENDER_OFFSET + i] = b));
  return ethers.utils.hexlify(buf);
}

/** Build a CctpMessageV2 GMP Circle message (exactly 180 bytes).
 *  Body = messageId at bytes [148, 180). */
function makeGmpCircleMessage(messageId: string): string {
  const buf = Buffer.alloc(180);
  const idBytes = ethers.utils.arrayify(messageId);
  idBytes.forEach((b, i) => (buf[148 + i] = b));
  return ethers.utils.hexlify(buf);
}

/** Build a Hyperlane TokenMessage body: recipient(32) + amount(32). */
function makeTokenBody(recipient: Uint8Array, amount: Uint8Array): Uint8Array {
  const buf = Buffer.alloc(64);
  recipient.forEach((b, i) => (buf[i] = b));
  amount.forEach((b, i) => (buf[32 + i] = b));
  return buf;
}

const RECIPIENT_A = Buffer.alloc(32, 0xaa);
const RECIPIENT_B = Buffer.alloc(32, 0xbb);
const AMOUNT_A = Buffer.alloc(32, 0x01);
const AMOUNT_B = Buffer.alloc(32, 0x02);
const SENDER_A = Buffer.alloc(32, 0x11);
const SENDER_B = Buffer.alloc(32, 0x22);
const SENDER_ZERO = Buffer.alloc(32, 0x00);
const SENDER_ZERO_HEX = ethers.utils.hexlify(SENDER_ZERO);
const MESSAGE_ID_A = ethers.utils.hexZeroPad('0xaa', 32);
const MESSAGE_ID_B = ethers.utils.hexZeroPad('0xbb', 32);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('findMatchingCircleMessage', () => {
  describe('single message', () => {
    it('returns the only message without inspecting its content', () => {
      const msg = makeBurnCircleMessage(RECIPIENT_A, AMOUNT_A);
      const body = makeTokenBody(RECIPIENT_B, AMOUNT_B); // deliberately different
      const result = findMatchingCircleMessage(
        [msg],
        body,
        MESSAGE_ID_A,
        SENDER_ZERO_HEX,
      );
      expect(result).to.equal(msg);
    });
  });

  describe('multiple token transfer messages', () => {
    it('matches message A by (messageSender, amount, mintRecipient)', () => {
      const msgA = makeBurnCircleMessage(RECIPIENT_A, AMOUNT_A, SENDER_A);
      const msgB = makeBurnCircleMessage(RECIPIENT_B, AMOUNT_B, SENDER_B);
      const bodyA = makeTokenBody(RECIPIENT_A, AMOUNT_A);
      expect(
        findMatchingCircleMessage(
          [msgA, msgB],
          bodyA,
          MESSAGE_ID_A,
          ethers.utils.hexlify(SENDER_A),
        ),
      ).to.equal(msgA);
    });

    it('matches message B by (messageSender, amount, mintRecipient)', () => {
      const msgA = makeBurnCircleMessage(RECIPIENT_A, AMOUNT_A, SENDER_A);
      const msgB = makeBurnCircleMessage(RECIPIENT_B, AMOUNT_B, SENDER_B);
      const bodyB = makeTokenBody(RECIPIENT_B, AMOUNT_B);
      expect(
        findMatchingCircleMessage(
          [msgA, msgB],
          bodyB,
          MESSAGE_ID_B,
          ethers.utils.hexlify(SENDER_B),
        ),
      ).to.equal(msgB);
    });

    it('disambiguates by sender when recipient and amount are identical', () => {
      const msgA = makeBurnCircleMessage(RECIPIENT_A, AMOUNT_A, SENDER_A);
      const msgB = makeBurnCircleMessage(RECIPIENT_A, AMOUNT_A, SENDER_B);
      const body = makeTokenBody(RECIPIENT_A, AMOUNT_A);
      expect(
        findMatchingCircleMessage(
          [msgA, msgB],
          body,
          MESSAGE_ID_A,
          ethers.utils.hexlify(SENDER_B),
        ),
      ).to.equal(msgB);
    });
  });

  describe('multiple GMP messages', () => {
    it('matches GMP message A by messageId', () => {
      const msgA = makeGmpCircleMessage(MESSAGE_ID_A);
      const msgB = makeGmpCircleMessage(MESSAGE_ID_B);
      const emptyBody = new Uint8Array(0); // GMP body is not a TokenMessage
      expect(
        findMatchingCircleMessage(
          [msgA, msgB],
          emptyBody,
          MESSAGE_ID_A,
          SENDER_ZERO_HEX,
        ),
      ).to.equal(msgA);
    });

    it('matches GMP message B by messageId', () => {
      const msgA = makeGmpCircleMessage(MESSAGE_ID_A);
      const msgB = makeGmpCircleMessage(MESSAGE_ID_B);
      const emptyBody = new Uint8Array(0);
      expect(
        findMatchingCircleMessage(
          [msgA, msgB],
          emptyBody,
          MESSAGE_ID_B,
          SENDER_ZERO_HEX,
        ),
      ).to.equal(msgB);
    });
  });

  describe('mixed token transfer + GMP in same tx', () => {
    it('matches the burn message for a token transfer', () => {
      const burnMsg = makeBurnCircleMessage(RECIPIENT_A, AMOUNT_A, SENDER_A);
      const gmpMsg = makeGmpCircleMessage(MESSAGE_ID_B);
      const tokenBody = makeTokenBody(RECIPIENT_A, AMOUNT_A);
      // Strategy 1 finds the burn message; GMP message is too short for strategy 1
      expect(
        findMatchingCircleMessage(
          [burnMsg, gmpMsg],
          tokenBody,
          MESSAGE_ID_A,
          ethers.utils.hexlify(SENDER_A),
        ),
      ).to.equal(burnMsg);
    });

    it('matches the GMP message for a GMP transfer', () => {
      const burnMsg = makeBurnCircleMessage(RECIPIENT_A, AMOUNT_A);
      const gmpMsg = makeGmpCircleMessage(MESSAGE_ID_B);
      const emptyBody = new Uint8Array(0);
      // Strategy 1 finds nothing (empty body); strategy 2 finds the GMP message
      expect(
        findMatchingCircleMessage(
          [burnMsg, gmpMsg],
          emptyBody,
          MESSAGE_ID_B,
          SENDER_ZERO_HEX,
        ),
      ).to.equal(gmpMsg);
    });
  });

  // Golden vector: byte positions are hardcoded as literals (not via CIRCLE_* constants)
  // so a wrong constant in cctpMessageMatcher.ts will cause a test failure here.
  //
  // CctpMessageV2 header = 148 bytes; BurnMessageV2 body immediately follows:
  //   version(4) burnToken(32) mintRecipient(32) amount(32) messageSender(32) ...
  //   ├─ mintRecipient: header(148) + version(4) + burnToken(32) = absolute 184
  //   ├─ amount:        184 + 32                                 = absolute 216
  //   └─ messageSender: 216 + 32                                 = absolute 248
  describe('golden vector — offsets hardcoded, not derived from constants', () => {
    it('matches the correct burn message by (sender, amount, mintRecipient)', () => {
      // Burn message A: build entirely from literal byte positions.
      const burnA = Buffer.alloc(280);
      burnA.fill(0xaa, 184, 216); // mintRecipient
      burnA.fill(0x01, 216, 248); // amount
      burnA.fill(0x11, 248, 280); // messageSender

      // Burn message B: different fields at the same literal positions.
      const burnB = Buffer.alloc(280);
      burnB.fill(0xbb, 184, 216); // mintRecipient
      burnB.fill(0x02, 216, 248); // amount
      burnB.fill(0x22, 248, 280); // messageSender

      // Hyperlane TokenMessage body: recipient(32) + amount(32)
      const bodyA = Buffer.alloc(64);
      bodyA.fill(0xaa, 0, 32); // recipient matches burnA mintRecipient
      bodyA.fill(0x01, 32, 64); // amount matches burnA amount

      const senderA = ethers.utils.hexlify(Buffer.alloc(32, 0x11));

      expect(
        findMatchingCircleMessage(
          [ethers.utils.hexlify(burnA), ethers.utils.hexlify(burnB)],
          bodyA,
          MESSAGE_ID_A,
          senderA,
        ),
      ).to.equal(ethers.utils.hexlify(burnA));
    });
  });

  describe('fallback', () => {
    it('returns null when no strategy matches', () => {
      const msgA = makeBurnCircleMessage(RECIPIENT_A, AMOUNT_A, SENDER_A);
      const msgB = makeBurnCircleMessage(RECIPIENT_B, AMOUNT_B, SENDER_B);
      // Body has wrong recipient/amount/sender and messageId does not match either
      const wrongBody = makeTokenBody(
        Buffer.alloc(32, 0xff),
        Buffer.alloc(32, 0xff),
      );
      expect(
        findMatchingCircleMessage(
          [msgA, msgB],
          wrongBody,
          MESSAGE_ID_A,
          SENDER_ZERO_HEX,
        ),
      ).to.equal(null);
    });
  });
});
