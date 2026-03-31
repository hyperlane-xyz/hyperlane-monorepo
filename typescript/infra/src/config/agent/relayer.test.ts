import { expect } from 'chai';

import { addressToBytes32 } from '@hyperlane-xyz/utils';

import { IcaMessageType, icaMatchingList } from './relayer.js';

describe('icaMatchingList', () => {
  // Velodrome Universal Router owner used in mainnet config
  const velodromeOwner = '0x01D40099fCD87C018969B0e8D4aB1633Fb34763C';

  describe('regex pattern generation', () => {
    it('should generate correct pattern for owner-only matching', () => {
      const matchingList = icaMatchingList({
        base: { owner: velodromeOwner },
        optimism: { owner: velodromeOwner },
      });

      expect(matchingList.length).to.be.greaterThan(0);

      // Find base -> optimism entry
      const entry = matchingList.find(
        (e) => e.originDomain === 8453 && e.destinationDomain === 10,
      );
      expect(entry).to.exist;
      expect(entry!.bodyRegex).to.exist;

      // Pattern should be: ^.{2} (any type) + owner bytes32 + .{64} (any ISM)
      const expectedOwnerHex = addressToBytes32(velodromeOwner)
        .toLowerCase()
        .replace(/^0x/, '');
      expect(entry!.bodyRegex).to.equal(`^.{2}${expectedOwnerHex}.{64}`);
    });

    it('should generate correct pattern for REVEAL message type', () => {
      const matchingList = icaMatchingList({
        optimism: { messageType: IcaMessageType.REVEAL },
        celo: { messageType: IcaMessageType.REVEAL },
      });

      expect(matchingList.length).to.be.greaterThan(0);
      const entry = matchingList[0];

      // Pattern should be: ^02 (REVEAL type) + .{64} (any ISM)
      expect(entry.bodyRegex).to.equal('^02.{64}');
    });

    it('should generate correct pattern for CALLS with all fields', () => {
      const ism = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const salt =
        '0x0000000000000000000000000000000000000000000000000000000000000001';

      const matchingList = icaMatchingList({
        base: {
          messageType: IcaMessageType.CALLS,
          owner: velodromeOwner,
          ism,
          salt,
        },
        optimism: {
          messageType: IcaMessageType.CALLS,
          owner: velodromeOwner,
          ism,
          salt,
        },
      });

      const entry = matchingList[0];
      const ownerHex = addressToBytes32(velodromeOwner)
        .toLowerCase()
        .replace(/^0x/, '');
      const ismHex = addressToBytes32(ism).toLowerCase().replace(/^0x/, '');
      const saltHex = salt.toLowerCase().replace(/^0x/, '');

      expect(entry.bodyRegex).to.equal(`^00${ownerHex}${ismHex}${saltHex}`);
    });
  });

  describe('message body matching', () => {
    it('should match CALLS message with correct owner', () => {
      const matchingList = icaMatchingList({
        base: { owner: velodromeOwner },
        optimism: { owner: velodromeOwner },
      });

      const entry = matchingList[0];
      const regex = new RegExp(entry.bodyRegex!);

      // Synthetic CALLS message: type(00) + owner + ism + salt + data
      const ownerBytes32 = addressToBytes32(velodromeOwner)
        .toLowerCase()
        .replace(/^0x/, '');
      const callsMessage = `00${ownerBytes32}${'a'.repeat(64)}${'b'.repeat(64)}deadbeef`;

      expect(regex.test(callsMessage)).to.be.true;
    });

    it('should match COMMITMENT message with correct owner', () => {
      const matchingList = icaMatchingList({
        base: { owner: velodromeOwner },
        optimism: { owner: velodromeOwner },
      });

      const entry = matchingList[0];
      const regex = new RegExp(entry.bodyRegex!);

      // Synthetic COMMITMENT message: type(01) + owner + ism + salt + commitment
      const ownerBytes32 = addressToBytes32(velodromeOwner)
        .toLowerCase()
        .replace(/^0x/, '');
      const commitmentMessage = `01${ownerBytes32}${'a'.repeat(64)}${'b'.repeat(64)}${'c'.repeat(64)}`;

      expect(regex.test(commitmentMessage)).to.be.true;
    });

    it('should NOT match REVEAL message with owner-based pattern', () => {
      const matchingList = icaMatchingList({
        base: { owner: velodromeOwner },
        optimism: { owner: velodromeOwner },
      });

      const entry = matchingList[0];
      const regex = new RegExp(entry.bodyRegex!);

      // Real REVEAL message from https://gist.github.com/yorhodes/e4b19fa63c6195cb725efbc3011e3abb
      const revealMessage =
        '020000000000000000000000000000000000000000000000000000000000000000002cd4f1bbd58a9c7fc481e3b8d319cea8795011b9dde770fa122c2e585fa01f69';

      expect(regex.test(revealMessage)).to.be.false;
    });

    it('should NOT match message with wrong owner', () => {
      const matchingList = icaMatchingList({
        base: { owner: velodromeOwner },
        optimism: { owner: velodromeOwner },
      });

      const entry = matchingList[0];
      const regex = new RegExp(entry.bodyRegex!);

      // CALLS message with different owner
      const differentOwner = '0x02D40099fCD87C018969B0e8D4aB1633Fb34763C';
      const ownerBytes32 = addressToBytes32(differentOwner)
        .toLowerCase()
        .replace(/^0x/, '');
      const callsMessage = `00${ownerBytes32}${'a'.repeat(64)}${'b'.repeat(64)}deadbeef`;

      expect(regex.test(callsMessage)).to.be.false;
    });

    it('should match REVEAL message with type-based pattern', () => {
      const matchingList = icaMatchingList({
        optimism: { messageType: IcaMessageType.REVEAL },
        celo: { messageType: IcaMessageType.REVEAL },
      });

      const entry = matchingList[0];
      const regex = new RegExp(entry.bodyRegex!);

      // Real REVEAL message
      const revealMessage =
        '020000000000000000000000000000000000000000000000000000000000000000002cd4f1bbd58a9c7fc481e3b8d319cea8795011b9dde770fa122c2e585fa01f69';

      expect(regex.test(revealMessage)).to.be.true;
    });

    it('should match messages with arbitrary suffixes', () => {
      const matchingList = icaMatchingList({
        base: { owner: velodromeOwner },
        optimism: { owner: velodromeOwner },
      });

      const entry = matchingList[0];
      const regex = new RegExp(entry.bodyRegex!);

      // CALLS message with lots of extra call data
      const ownerBytes32 = addressToBytes32(velodromeOwner)
        .toLowerCase()
        .replace(/^0x/, '');
      const callsMessage = `00${ownerBytes32}${'a'.repeat(64)}${'b'.repeat(64)}${'extra_data_here'.repeat(100)}`;

      expect(regex.test(callsMessage)).to.be.true;
    });
  });

  describe('matching list structure', () => {
    it('should generate entries for all chain pairs', () => {
      const matchingList = icaMatchingList({
        base: { owner: velodromeOwner },
        optimism: { owner: velodromeOwner },
        celo: { owner: velodromeOwner },
      });

      // 3 chains should create 3 * 2 = 6 entries (each chain to 2 others)
      expect(matchingList).to.have.lengthOf(6);

      // Check that no chain has entry to itself
      matchingList.forEach((entry) => {
        expect(entry.originDomain).to.not.equal(entry.destinationDomain);
      });
    });

    it('should set sender and recipient addresses to ICA routers', () => {
      const matchingList = icaMatchingList({
        base: { owner: velodromeOwner },
        optimism: { owner: velodromeOwner },
      });

      matchingList.forEach((entry) => {
        expect(entry.senderAddress).to.exist;
        expect(entry.recipientAddress).to.exist;
        // Addresses should be bytes32 format (66 chars with 0x prefix)
        expect(entry.senderAddress).to.match(/^0x[a-f0-9]{64}$/i);
        expect(entry.recipientAddress).to.match(/^0x[a-f0-9]{64}$/i);
      });
    });

    it('should throw error if ICA router not found', () => {
      expect(() => {
        icaMatchingList({
          nonexistentchain: { owner: velodromeOwner },
        });
      }).to.throw(/No ICA router found for chain nonexistentchain/);
    });

    it('should throw error if REVEAL type has owner field', () => {
      expect(() => {
        icaMatchingList({
          optimism: {
            messageType: IcaMessageType.REVEAL,
            owner: velodromeOwner,
          },
        });
      }).to.throw(/REVEAL messages do not have an owner field/);
    });

    it('should throw error if REVEAL type has salt field', () => {
      expect(() => {
        icaMatchingList({
          optimism: {
            messageType: IcaMessageType.REVEAL,
            salt: '0x0000000000000000000000000000000000000000000000000000000000000001',
          },
        });
      }).to.throw(/REVEAL messages do not have a salt field/);
    });

    it('should throw error if REVEAL type has both owner and salt fields', () => {
      expect(() => {
        icaMatchingList({
          optimism: {
            messageType: IcaMessageType.REVEAL,
            owner: velodromeOwner,
            salt: '0x0000000000000000000000000000000000000000000000000000000000000001',
          },
        });
      }).to.throw(/REVEAL messages do not have an owner field/);
    });
  });

  describe('different message types', () => {
    it('should handle CALLS type specifically', () => {
      const matchingList = icaMatchingList({
        base: { messageType: IcaMessageType.CALLS, owner: velodromeOwner },
        optimism: { messageType: IcaMessageType.CALLS, owner: velodromeOwner },
      });

      const entry = matchingList[0];
      const regex = new RegExp(entry.bodyRegex!);

      // Should match CALLS (00)
      const ownerBytes32 = addressToBytes32(velodromeOwner)
        .toLowerCase()
        .replace(/^0x/, '');
      const callsMessage = `00${ownerBytes32}${'a'.repeat(64)}${'b'.repeat(64)}`;
      expect(regex.test(callsMessage)).to.be.true;

      // Should NOT match COMMITMENT (01)
      const commitmentMessage = `01${ownerBytes32}${'a'.repeat(64)}${'b'.repeat(64)}`;
      expect(regex.test(commitmentMessage)).to.be.false;
    });

    it('should handle COMMITMENT type specifically', () => {
      const matchingList = icaMatchingList({
        base: {
          messageType: IcaMessageType.COMMITMENT,
          owner: velodromeOwner,
        },
        optimism: {
          messageType: IcaMessageType.COMMITMENT,
          owner: velodromeOwner,
        },
      });

      const entry = matchingList[0];
      const regex = new RegExp(entry.bodyRegex!);

      // Should match COMMITMENT (01)
      const ownerBytes32 = addressToBytes32(velodromeOwner)
        .toLowerCase()
        .replace(/^0x/, '');
      const commitmentMessage = `01${ownerBytes32}${'a'.repeat(64)}${'b'.repeat(64)}`;
      expect(regex.test(commitmentMessage)).to.be.true;

      // Should NOT match CALLS (00)
      const callsMessage = `00${ownerBytes32}${'a'.repeat(64)}${'b'.repeat(64)}`;
      expect(regex.test(callsMessage)).to.be.false;
    });

    it('should handle REVEAL type layout correctly', () => {
      const ism = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const matchingList = icaMatchingList({
        optimism: { messageType: IcaMessageType.REVEAL, ism },
        celo: { messageType: IcaMessageType.REVEAL, ism },
      });

      const entry = matchingList[0];
      const regex = new RegExp(entry.bodyRegex!);

      // REVEAL format: type(02) + ISM (at bytes 1-33, not 33-65)
      const ismBytes32 = addressToBytes32(ism).toLowerCase().replace(/^0x/, '');
      const revealMessage = `02${ismBytes32}${'c'.repeat(64)}`;

      expect(regex.test(revealMessage)).to.be.true;
    });
  });
});
