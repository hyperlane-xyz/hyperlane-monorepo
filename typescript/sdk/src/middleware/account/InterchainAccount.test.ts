import { expect } from 'chai';

import { commitmentFromRevealMessage } from './InterchainAccount.js';

describe('commitmentFromRevealMessage', () => {
  // https://explorer.hyperlane.xyz/message/0xd123b9eb8fc8777adf50963b2ad283f05332c584a1e4002f9e4ad21bdafea069
  const REVEAL_MESSAGE =
    '0x0200000000000000000000000000000000000000000000000000000000000000002cd4f1bbd58a9c7fc481e3b8d319cea8795011b9dde770fa122c2e585fa01f69';
  const COMMITMENT =
    '0x2cd4f1bbd58a9c7fc481e3b8d319cea8795011b9dde770fa122c2e585fa01f69';

  describe('Valid inputs', () => {
    it('should extract commitment from a valid 65-byte message', () => {
      const result = commitmentFromRevealMessage(REVEAL_MESSAGE);
      expect(result).to.equal(COMMITMENT);
    });
  });

  describe('Invalid inputs - should throw', () => {
    it('should throw when message is too short (< 65 bytes)', () => {
      const shortMessage = REVEAL_MESSAGE.slice(0, 2 + 64 * 2);
      expect(() => commitmentFromRevealMessage(shortMessage)).to.throw(
        'Invalid reveal message: expected at least 65 bytes, got 64 bytes',
      );
    });
  });
});
