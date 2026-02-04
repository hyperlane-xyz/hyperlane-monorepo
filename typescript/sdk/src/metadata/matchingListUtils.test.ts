import { expect } from 'chai';

import type { MatchingList } from './matchingList.js';
import {
  type MatchingListMessage,
  messageMatchesMatchingList,
} from './matchingListUtils.js';

describe('matchingListUtils', () => {
  describe('messageMatchesMatchingList', () => {
    const testMessage: MatchingListMessage = {
      id: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      origin: 1,
      destination: 2,
      sender: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      recipient: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      body: '0xdeadbeef',
    };

    describe('empty/undefined list (wildcard)', () => {
      it('should match all messages when list is undefined', () => {
        expect(messageMatchesMatchingList(undefined, testMessage)).to.be.true;
      });

      it('should match all messages when list is empty', () => {
        expect(messageMatchesMatchingList([], testMessage)).to.be.true;
      });
    });

    describe('originDomain matching', () => {
      it('should match exact originDomain', () => {
        const list: MatchingList = [{ originDomain: 1 }];
        expect(messageMatchesMatchingList(list, testMessage)).to.be.true;
      });

      it('should reject non-matching originDomain', () => {
        const list: MatchingList = [{ originDomain: 99 }];
        expect(messageMatchesMatchingList(list, testMessage)).to.be.false;
      });

      it('should match wildcard originDomain', () => {
        const list: MatchingList = [{ originDomain: '*' }];
        expect(messageMatchesMatchingList(list, testMessage)).to.be.true;
      });

      it('should match originDomain in array', () => {
        const list: MatchingList = [{ originDomain: [1, 3, 5] }];
        expect(messageMatchesMatchingList(list, testMessage)).to.be.true;
      });

      it('should reject originDomain not in array', () => {
        const list: MatchingList = [{ originDomain: [3, 5, 7] }];
        expect(messageMatchesMatchingList(list, testMessage)).to.be.false;
      });
    });

    describe('destinationDomain matching', () => {
      it('should match exact destinationDomain', () => {
        const list: MatchingList = [{ destinationDomain: 2 }];
        expect(messageMatchesMatchingList(list, testMessage)).to.be.true;
      });

      it('should reject non-matching destinationDomain', () => {
        const list: MatchingList = [{ destinationDomain: 99 }];
        expect(messageMatchesMatchingList(list, testMessage)).to.be.false;
      });

      it('should match wildcard destinationDomain', () => {
        const list: MatchingList = [{ destinationDomain: '*' }];
        expect(messageMatchesMatchingList(list, testMessage)).to.be.true;
      });
    });

    describe('senderAddress matching', () => {
      it('should match exact senderAddress (lowercase)', () => {
        const list: MatchingList = [
          { senderAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        ];
        expect(messageMatchesMatchingList(list, testMessage)).to.be.true;
      });

      it('should match senderAddress case-insensitively', () => {
        const list: MatchingList = [
          { senderAddress: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
        ];
        expect(messageMatchesMatchingList(list, testMessage)).to.be.true;
      });

      it('should reject non-matching senderAddress', () => {
        const list: MatchingList = [
          { senderAddress: '0xcccccccccccccccccccccccccccccccccccccccc' },
        ];
        expect(messageMatchesMatchingList(list, testMessage)).to.be.false;
      });

      it('should match wildcard senderAddress', () => {
        const list: MatchingList = [{ senderAddress: '*' }];
        expect(messageMatchesMatchingList(list, testMessage)).to.be.true;
      });

      it('should match senderAddress in array', () => {
        const list: MatchingList = [
          {
            senderAddress: [
              '0xcccccccccccccccccccccccccccccccccccccccc',
              '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            ],
          },
        ];
        expect(messageMatchesMatchingList(list, testMessage)).to.be.true;
      });
    });

    describe('recipientAddress matching', () => {
      it('should match exact recipientAddress', () => {
        const list: MatchingList = [
          { recipientAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
        ];
        expect(messageMatchesMatchingList(list, testMessage)).to.be.true;
      });

      it('should reject non-matching recipientAddress', () => {
        const list: MatchingList = [
          { recipientAddress: '0xcccccccccccccccccccccccccccccccccccccccc' },
        ];
        expect(messageMatchesMatchingList(list, testMessage)).to.be.false;
      });
    });

    describe('messageId matching', () => {
      it('should match exact messageId', () => {
        const list: MatchingList = [
          {
            messageId:
              '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
          },
        ];
        expect(messageMatchesMatchingList(list, testMessage)).to.be.true;
      });

      it('should reject non-matching messageId', () => {
        const list: MatchingList = [
          {
            messageId:
              '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
          },
        ];
        expect(messageMatchesMatchingList(list, testMessage)).to.be.false;
      });

      it('should match wildcard messageId', () => {
        const list: MatchingList = [{ messageId: '*' }];
        expect(messageMatchesMatchingList(list, testMessage)).to.be.true;
      });
    });

    describe('bodyRegex matching', () => {
      it('should match body with regex', () => {
        const list: MatchingList = [{ bodyRegex: 'dead' }];
        expect(messageMatchesMatchingList(list, testMessage)).to.be.true;
      });

      it('should match body with full regex pattern', () => {
        const list: MatchingList = [{ bodyRegex: '^0x[a-f0-9]+$' }];
        expect(messageMatchesMatchingList(list, testMessage)).to.be.true;
      });

      it('should reject non-matching bodyRegex', () => {
        const list: MatchingList = [{ bodyRegex: 'notfound' }];
        expect(messageMatchesMatchingList(list, testMessage)).to.be.false;
      });

      it('should handle invalid regex gracefully', () => {
        const list: MatchingList = [{ bodyRegex: '[invalid(' }];
        expect(messageMatchesMatchingList(list, testMessage)).to.be.false;
      });
    });

    describe('multiple fields in element (AND logic)', () => {
      it('should match when ALL fields match', () => {
        const list: MatchingList = [
          {
            originDomain: 1,
            destinationDomain: 2,
            senderAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
        ];
        expect(messageMatchesMatchingList(list, testMessage)).to.be.true;
      });

      it('should reject when ANY field does not match', () => {
        const list: MatchingList = [
          {
            originDomain: 1,
            destinationDomain: 99, // Does not match
            senderAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
        ];
        expect(messageMatchesMatchingList(list, testMessage)).to.be.false;
      });
    });

    describe('multiple elements in list (OR logic)', () => {
      it('should match when ANY element matches', () => {
        const list: MatchingList = [
          { originDomain: 99 }, // Does not match
          { originDomain: 1 }, // Matches
        ];
        expect(messageMatchesMatchingList(list, testMessage)).to.be.true;
      });

      it('should reject when NO element matches', () => {
        const list: MatchingList = [
          { originDomain: 99 },
          { destinationDomain: 99 },
        ];
        expect(messageMatchesMatchingList(list, testMessage)).to.be.false;
      });

      it('should match first element when multiple could match', () => {
        const list: MatchingList = [
          { originDomain: 1 }, // Matches
          { destinationDomain: 2 }, // Also would match
        ];
        expect(messageMatchesMatchingList(list, testMessage)).to.be.true;
      });
    });

    describe('undefined message fields', () => {
      it('should not match when required field is undefined', () => {
        const messageWithoutOrigin: MatchingListMessage = {
          destination: 2,
          sender: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        };
        const list: MatchingList = [{ originDomain: 1 }];
        expect(messageMatchesMatchingList(list, messageWithoutOrigin)).to.be
          .false;
      });

      it('should match wildcard even when field is undefined', () => {
        // Wildcard should still require the field to be present
        const messageWithoutOrigin: MatchingListMessage = {
          destination: 2,
        };
        const list: MatchingList = [{ originDomain: '*' }];
        // Even with wildcard, undefined origin should not match
        expect(messageMatchesMatchingList(list, messageWithoutOrigin)).to.be
          .false;
      });
    });
  });
});
