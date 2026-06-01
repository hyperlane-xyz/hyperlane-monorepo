import { expect } from 'chai';
import { ethers } from 'ethers';

import {
  CIRCLE_AMOUNT_OFFSET,
  CIRCLE_MINT_RECIPIENT_OFFSET,
  findMatchingCircleMessage,
} from '../../src/services/cctpMessageMatcher.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal CctpMessageV2 + BurnMessageV2 Circle message (≥ 248 bytes).
 *  Only mintRecipient and amount are set meaningfully; everything else is zeros. */
function makeBurnCircleMessage(
  mintRecipient: Uint8Array,
  amount: Uint8Array,
): string {
  const buf = Buffer.alloc(248);
  mintRecipient.forEach((b, i) => (buf[CIRCLE_MINT_RECIPIENT_OFFSET + i] = b));
  amount.forEach((b, i) => (buf[CIRCLE_AMOUNT_OFFSET + i] = b));
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
const MESSAGE_ID_A = ethers.utils.hexZeroPad('0xaa', 32);
const MESSAGE_ID_B = ethers.utils.hexZeroPad('0xbb', 32);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('findMatchingCircleMessage', () => {
  describe('single message', () => {
    it('returns the only message without inspecting its content', () => {
      const msg = makeBurnCircleMessage(RECIPIENT_A, AMOUNT_A);
      const body = makeTokenBody(RECIPIENT_B, AMOUNT_B); // deliberately different
      const result = findMatchingCircleMessage([msg], body, MESSAGE_ID_A);
      expect(result).to.equal(msg);
    });
  });

  describe('multiple token transfer messages', () => {
    it('matches message A by (mintRecipient, amount)', () => {
      const msgA = makeBurnCircleMessage(RECIPIENT_A, AMOUNT_A);
      const msgB = makeBurnCircleMessage(RECIPIENT_B, AMOUNT_B);
      const bodyA = makeTokenBody(RECIPIENT_A, AMOUNT_A);
      expect(
        findMatchingCircleMessage([msgA, msgB], bodyA, MESSAGE_ID_A),
      ).to.equal(msgA);
    });

    it('matches message B by (mintRecipient, amount)', () => {
      const msgA = makeBurnCircleMessage(RECIPIENT_A, AMOUNT_A);
      const msgB = makeBurnCircleMessage(RECIPIENT_B, AMOUNT_B);
      const bodyB = makeTokenBody(RECIPIENT_B, AMOUNT_B);
      expect(
        findMatchingCircleMessage([msgA, msgB], bodyB, MESSAGE_ID_B),
      ).to.equal(msgB);
    });
  });

  describe('multiple GMP messages', () => {
    it('matches GMP message A by messageId', () => {
      const msgA = makeGmpCircleMessage(MESSAGE_ID_A);
      const msgB = makeGmpCircleMessage(MESSAGE_ID_B);
      const emptyBody = new Uint8Array(0); // GMP body is not a TokenMessage
      expect(
        findMatchingCircleMessage([msgA, msgB], emptyBody, MESSAGE_ID_A),
      ).to.equal(msgA);
    });

    it('matches GMP message B by messageId', () => {
      const msgA = makeGmpCircleMessage(MESSAGE_ID_A);
      const msgB = makeGmpCircleMessage(MESSAGE_ID_B);
      const emptyBody = new Uint8Array(0);
      expect(
        findMatchingCircleMessage([msgA, msgB], emptyBody, MESSAGE_ID_B),
      ).to.equal(msgB);
    });
  });

  describe('mixed token transfer + GMP in same tx', () => {
    it('matches the burn message for a token transfer', () => {
      const burnMsg = makeBurnCircleMessage(RECIPIENT_A, AMOUNT_A);
      const gmpMsg = makeGmpCircleMessage(MESSAGE_ID_B);
      const tokenBody = makeTokenBody(RECIPIENT_A, AMOUNT_A);
      // Strategy 1 finds the burn message; GMP message is too short for strategy 1
      expect(
        findMatchingCircleMessage([burnMsg, gmpMsg], tokenBody, MESSAGE_ID_A),
      ).to.equal(burnMsg);
    });

    it('matches the GMP message for a GMP transfer', () => {
      const burnMsg = makeBurnCircleMessage(RECIPIENT_A, AMOUNT_A);
      const gmpMsg = makeGmpCircleMessage(MESSAGE_ID_B);
      const emptyBody = new Uint8Array(0);
      // Strategy 1 finds nothing (empty body); strategy 2 finds the GMP message
      expect(
        findMatchingCircleMessage([burnMsg, gmpMsg], emptyBody, MESSAGE_ID_B),
      ).to.equal(gmpMsg);
    });
  });

  describe('fallback', () => {
    it('returns messages[0] when no strategy matches', () => {
      const msgA = makeBurnCircleMessage(RECIPIENT_A, AMOUNT_A);
      const msgB = makeBurnCircleMessage(RECIPIENT_B, AMOUNT_B);
      // Body has wrong recipient/amount and messageId does not match either
      const wrongBody = makeTokenBody(
        Buffer.alloc(32, 0xff),
        Buffer.alloc(32, 0xff),
      );
      expect(
        findMatchingCircleMessage([msgA, msgB], wrongBody, MESSAGE_ID_A),
      ).to.equal(msgA);
    });
  });
});
