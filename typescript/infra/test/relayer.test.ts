import { expect } from 'chai';
import sinon from 'sinon';

import {
  ZERO_ADDRESS_HEX_32,
  addressToBytes32,
  assert,
} from '@hyperlane-xyz/utils';

import { getIcaRouterAddresses, getRegistry } from '../config/registry.js';

import {
  IcaMessageType,
  icaMatchingList,
  metadexVoterMetricAppContexts,
  multiAddressChainMapMatchingList,
} from '../src/config/agent/relayer.js';

describe('multiAddressChainMapMatchingList', () => {
  const addrA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const addrB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const addrC = '0xcccccccccccccccccccccccccccccccccccccccc';

  it('expands all (source, destination) pairs, skipping self-pairs', () => {
    const result = multiAddressChainMapMatchingList({
      ethereum: [addrA],
      optimism: [addrC],
      base: [addrB],
    });
    // 3 chains → 3*2 = 6 entries
    expect(result).to.have.lengthOf(6);
    result.forEach((entry) =>
      expect(entry.originDomain).to.not.equal(entry.destinationDomain),
    );
  });

  it('sets senderAddress and recipientAddress as bytes32 arrays for the correct chains', () => {
    const result = multiAddressChainMapMatchingList({
      ethereum: [addrA, addrB], // domain 1
      optimism: [addrC], // domain 10
    });
    expect(result).to.have.lengthOf(2);

    const ethToOp = result.find(
      (e) => e.originDomain === 1 && e.destinationDomain === 10,
    );
    expect(ethToOp).to.exist;
    expect(ethToOp!.senderAddress).to.deep.equal(
      [addrA, addrB].map((a) => addressToBytes32(a)),
    );
    expect(ethToOp!.recipientAddress).to.deep.equal([addressToBytes32(addrC)]);

    const opToEth = result.find(
      (e) => e.originDomain === 10 && e.destinationDomain === 1,
    );
    expect(opToEth).to.exist;
    expect(opToEth!.senderAddress).to.deep.equal([addressToBytes32(addrC)]);
    expect(opToEth!.recipientAddress).to.deep.equal(
      [addrA, addrB].map((a) => addressToBytes32(a)),
    );
  });

  it('deduplicates addresses within a chain', () => {
    const result = multiAddressChainMapMatchingList({
      ethereum: [addrA, addrA, addrB],
      optimism: [addrC],
    });
    const ethToOp = result.find(
      (e) => e.originDomain === 1 && e.destinationDomain === 10,
    );
    expect(ethToOp!.senderAddress).to.deep.equal(
      [addrA, addrB].map((a) => addressToBytes32(a)),
    );
  });
});

describe('icaMatchingList', () => {
  // Velodrome Universal Router owner used in mainnet config
  const velodromeOwner = '0x01D40099fCD87C018969B0e8D4aB1633Fb34763C';

  it('matches the Base to Arbitrum V3 reveal while preserving both V2 routers', () => {
    const matchingList = icaMatchingList({
      base: { messageType: IcaMessageType.REVEAL },
      arbitrum: { messageType: IcaMessageType.REVEAL },
    });
    const entry = matchingList.find(
      (item) => item.originDomain === 8453 && item.destinationDomain === 42161,
    );
    assert(entry, 'Missing Base to Arbitrum matching rule');
    expect([entry.senderAddress].flat()).to.include(
      addressToBytes32('0x0ca10c09cad7afe01619a4a9acdf6481938258c4'),
    );
    expect([entry.recipientAddress].flat()).to.include(
      addressToBytes32('0xa0f62e4a4597471aa6fac829aca3c468ea751c3c'),
    );
    expect([entry.senderAddress].flat()).to.have.lengthOf(2);
    expect([entry.recipientAddress].flat()).to.have.lengthOf(2);
    assert(entry.bodyRegex, 'Missing reveal regex');
    expect(
      new RegExp(entry.bodyRegex).test(
        '02' + '00'.repeat(32) + 'ab'.repeat(32),
      ),
    ).to.be.true;
  });

  it('deduplicates registry router versions ignoring address case', () => {
    const registry = getRegistry();
    const addresses = registry.getAddresses();
    const router = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const stub = sinon.stub(registry, 'getAddresses').returns({
      ...addresses,
      base: {
        ...addresses.base,
        interchainAccountRouter: router,
        interchainAccountRouterV3: '0x' + router.slice(2).toUpperCase(),
      },
    });
    try {
      expect(getIcaRouterAddresses('base')).to.deep.equal([router]);
      const matchingList = icaMatchingList({ base: {}, optimism: {} });
      const entry = matchingList.find((item) => item.originDomain === 8453);
      assert(entry, 'Missing Base matching rule');
      expect(entry.senderAddress).to.equal(addressToBytes32(router));
    } finally {
      stub.restore();
    }
  });

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
        for (const address of [
          entry.senderAddress,
          entry.recipientAddress,
        ].flat()) {
          expect(address).to.match(/^0x[a-f0-9]{64}$/i);
        }
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

describe('metadexVoterMetricAppContexts', () => {
  const rootAdapter = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const leafAdapter = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const secondRootAdapter = '0xcccccccccccccccccccccccccccccccccccccccc';
  const secondLeafAdapter = '0xdddddddddddddddddddddddddddddddddddddddd';

  it('matches every voter type only in its implemented direction', () => {
    const contexts = metadexVoterMetricAppContexts({
      prefix: 'metadex',
      rootChain: 'ethereum',
      leaves: {
        optimism: { rootAdapter, leafAdapters: [leafAdapter] },
        arbitrum: {
          rootAdapter: secondRootAdapter,
          leafAdapters: [secondLeafAdapter],
        },
      },
    });

    expect(contexts.map(({ name }) => name)).to.deep.equal([
      'metadex_allocate_chain',
      'metadex_allocate_gauge',
      'metadex_claim_rewards',
      'metadex_redeem',
      'metadex_set_operator',
      'metadex_deallocate',
      'metadex_reduce_cooldown',
      'metadex_emergency_deallocate',
    ]);
    contexts.forEach((context, index) => {
      expect(context.matchingList).to.have.lengthOf(2);
      context.matchingList.forEach((entry) =>
        expect(entry.bodyRegex).to.equal(
          `^${(index + 1).toString(16).padStart(2, '0')}`,
        ),
      );
    });

    const rootToLeaf = contexts[0].matchingList[0];
    expect(rootToLeaf).to.deep.include({
      originDomain: 1,
      senderAddress: addressToBytes32(rootAdapter),
      destinationDomain: 10,
    });
    expect(rootToLeaf.recipientAddress).to.deep.equal([
      addressToBytes32(leafAdapter),
    ]);

    const leafToRoot = contexts[3].matchingList[0];
    expect(leafToRoot).to.deep.include({
      originDomain: 10,
      destinationDomain: 1,
      recipientAddress: addressToBytes32(rootAdapter),
    });
    expect(leafToRoot.senderAddress).to.deep.equal([
      addressToBytes32(leafAdapter),
    ]);

    expect(contexts[0].matchingList[1]).to.deep.include({
      originDomain: 1,
      senderAddress: addressToBytes32(secondRootAdapter),
      destinationDomain: 42161,
    });
    expect(contexts[0].matchingList[1].recipientAddress).to.deep.equal([
      addressToBytes32(secondLeafAdapter),
    ]);

    for (const index of [0, 1, 2, 4, 6, 7]) {
      expect(
        contexts[index].matchingList.some(
          ({ originDomain, destinationDomain }) =>
            originDomain === 10 && destinationDomain === 1,
        ),
      ).to.equal(false);
    }
    for (const index of [3, 5]) {
      expect(
        contexts[index].matchingList.some(
          ({ originDomain, destinationDomain }) =>
            originDomain === 1 && destinationDomain === 10,
        ),
      ).to.equal(false);
    }
  });

  it('rejects a configuration without leaf routes', () => {
    expect(() =>
      metadexVoterMetricAppContexts({
        prefix: 'metadex',
        rootChain: 'ethereum',
        leaves: {},
      }),
    ).to.throw('No MetaDEX leaf routes configured');
  });

  it('rejects zero adapter addresses', () => {
    expect(() =>
      metadexVoterMetricAppContexts({
        prefix: 'metadex',
        rootChain: 'ethereum',
        leaves: {
          optimism: {
            rootAdapter: ZERO_ADDRESS_HEX_32,
            leafAdapters: [leafAdapter],
          },
        },
      }),
    ).to.throw('Invalid zero MetaDEX root adapter for leaf optimism');

    expect(() =>
      metadexVoterMetricAppContexts({
        prefix: 'metadex',
        rootChain: 'ethereum',
        leaves: {
          optimism: {
            rootAdapter,
            leafAdapters: [ZERO_ADDRESS_HEX_32],
          },
        },
      }),
    ).to.throw('Invalid zero MetaDEX leaf adapter for leaf optimism');
  });
  it('names contexts with the configured prefix', () => {
    const contexts = metadexVoterMetricAppContexts({
      prefix: 'metadex_staging',
      rootChain: 'base',
      leaves: { optimism: { rootAdapter, leafAdapters: [leafAdapter] } },
    });

    expect(contexts.map(({ name }) => name)).to.deep.equal([
      'metadex_staging_allocate_chain',
      'metadex_staging_allocate_gauge',
      'metadex_staging_claim_rewards',
      'metadex_staging_redeem',
      'metadex_staging_set_operator',
      'metadex_staging_deallocate',
      'metadex_staging_reduce_cooldown',
      'metadex_staging_emergency_deallocate',
    ]);
  });

  it('rejects an empty prefix', () => {
    expect(() =>
      metadexVoterMetricAppContexts({
        prefix: '',
        rootChain: 'base',
        leaves: { optimism: { rootAdapter, leafAdapters: [leafAdapter] } },
      }),
    ).to.throw('MetaDEX app context prefix is required');
  });
});
