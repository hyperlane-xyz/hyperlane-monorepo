import { expect } from 'chai';

import { computeMessageId, extractAddress, parseMessage } from './events.js';

describe('events', () => {
  describe('parseMessage', () => {
    it('parses a valid Hyperlane v3 message', () => {
      // Construct a valid message:
      // version (1 byte) + nonce (4 bytes) + origin (4 bytes) + sender (32 bytes)
      // + destination (4 bytes) + recipient (32 bytes) + body (variable)
      const version = '03'; // version 3
      const nonce = '00000001'; // nonce 1
      const origin = '00000001'; // origin domain 1
      const sender =
        '0000000000000000000000001234567890abcdef1234567890abcdef12345678';
      const destination = '00000002'; // destination domain 2
      const recipient =
        '000000000000000000000000abcdefabcdefabcdefabcdefabcdefabcdefabcd';
      const body = 'deadbeef';

      const message =
        `0x${version}${nonce}${origin}${sender}${destination}${recipient}${body}` as `0x${string}`;

      const parsed = parseMessage(message);

      expect(parsed.version).to.equal(3);
      expect(parsed.nonce).to.equal(1);
      expect(parsed.origin).to.equal(1);
      expect(parsed.sender).to.equal(`0x${sender}`);
      expect(parsed.destination).to.equal(2);
      expect(parsed.recipient).to.equal(`0x${recipient}`);
      expect(parsed.body).to.equal(`0x${body}`);
    });

    it('parses a message with empty body', () => {
      const version = '03';
      const nonce = '00000000';
      const origin = '000003e8'; // 1000
      const sender =
        '0000000000000000000000000000000000000000000000000000000000000001';
      const destination = '000003e9'; // 1001
      const recipient =
        '0000000000000000000000000000000000000000000000000000000000000002';

      const message =
        `0x${version}${nonce}${origin}${sender}${destination}${recipient}` as `0x${string}`;

      const parsed = parseMessage(message);

      expect(parsed.version).to.equal(3);
      expect(parsed.nonce).to.equal(0);
      expect(parsed.origin).to.equal(1000);
      expect(parsed.destination).to.equal(1001);
      expect(parsed.body).to.equal('0x');
    });

    it('throws for message shorter than minimum length', () => {
      const shortMessage = '0x0102030405' as `0x${string}`;

      expect(() => parseMessage(shortMessage)).to.throw(
        'Invalid message length',
      );
    });
  });

  describe('computeMessageId', () => {
    it('computes keccak256 hash of message', () => {
      // Known test vector: keccak256 of "hello"
      const message = '0x68656c6c6f' as `0x${string}`; // "hello" in hex

      const id = computeMessageId(message);

      // keccak256("hello") = 0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8
      expect(id).to.equal(
        '0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8',
      );
    });

    it('produces different IDs for different messages', () => {
      const msg1 = '0x01' as `0x${string}`;
      const msg2 = '0x02' as `0x${string}`;

      const id1 = computeMessageId(msg1);
      const id2 = computeMessageId(msg2);

      expect(id1).to.not.equal(id2);
    });
  });

  describe('extractAddress', () => {
    it('extracts 20-byte address from 32-byte padded format', () => {
      // Address 0x1234567890abcdef1234567890abcdef12345678 padded to 32 bytes
      const padded =
        '0x0000000000000000000000001234567890abcdef1234567890abcdef12345678' as `0x${string}`;

      const address = extractAddress(padded);

      expect(address).to.equal('0x1234567890abcdef1234567890abcdef12345678');
    });

    it('extracts zero address', () => {
      const padded =
        '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`;

      const address = extractAddress(padded);

      expect(address).to.equal('0x0000000000000000000000000000000000000000');
    });

    it('throws for invalid length', () => {
      const shortPadded = '0x1234' as `0x${string}`;

      expect(() => extractAddress(shortPadded)).to.throw(
        'Invalid padded address length',
      );
    });
  });
});
