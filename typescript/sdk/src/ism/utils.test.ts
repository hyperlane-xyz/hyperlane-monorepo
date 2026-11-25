import { expect } from 'chai';

import { formatMessage, messageId } from '@hyperlane-xyz/utils';

import type { HyperlaneContracts } from '../contracts/types.js';
import type { ProxyFactoryFactories } from '../deploy/contracts.js';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { randomAddress } from '../test/testUtils.js';

import { BlacklistIsmConfig, IsmConfig, IsmType } from './types.js';
import {
  SAMPLE_VERIFY_ADDRESS,
  collectValidators,
  moduleCanCertainlyVerify,
  moduleMatchesConfig,
  type OffchainLookupRequest,
  offchainLookupRequestHash,
} from './utils.js';

describe('ism utils', () => {
  describe('moduleCanCertainlyVerify', () => {
    const origin = TestChainName.test1;
    const destination = TestChainName.test2;

    let multiProvider: MultiProvider;
    let sampleMessageId: string;

    beforeEach(() => {
      multiProvider = MultiProvider.createTestMultiProvider();

      // Mirror the deterministic sample message the helper builds internally.
      const sampleMessage = formatMessage(
        0,
        0,
        multiProvider.getDomainId(origin),
        SAMPLE_VERIFY_ADDRESS,
        multiProvider.getDomainId(destination),
        SAMPLE_VERIFY_ADDRESS,
        '0x',
      );
      sampleMessageId = messageId(sampleMessage);
    });

    it('returns false when the sample message id is blacklisted', async () => {
      const config: BlacklistIsmConfig = {
        type: IsmType.BLACKLIST,
        owner: randomAddress(),
        blacklistedIds: [sampleMessageId],
      };

      const result = await moduleCanCertainlyVerify(
        config,
        multiProvider,
        origin,
        destination,
      );

      expect(result).to.be.false;
    });

    it('matches blacklisted ids case-insensitively', async () => {
      const config: BlacklistIsmConfig = {
        type: IsmType.BLACKLIST,
        owner: randomAddress(),
        blacklistedIds: [sampleMessageId.toUpperCase()],
      };

      const result = await moduleCanCertainlyVerify(
        config,
        multiProvider,
        origin,
        destination,
      );

      expect(result).to.be.false;
    });

    it('returns true when the sample message id is not blacklisted', async () => {
      const config: BlacklistIsmConfig = {
        type: IsmType.BLACKLIST,
        owner: randomAddress(),
        blacklistedIds: [messageId('0xdeadbeef')],
      };

      const result = await moduleCanCertainlyVerify(
        config,
        multiProvider,
        origin,
        destination,
      );

      expect(result).to.be.true;
    });

    it('returns false for the state-dependent hybrid hook/ISMs', async () => {
      const hybrids: IsmConfig[] = [
        {
          type: IsmType.NET_FLOW_RATE_LIMITED,
          thresholdBps: 500,
          duration: 86400n,
          owner: randomAddress(),
        },
        {
          type: IsmType.DELAYED_FLOW_ROUTER,
          thresholdBps: 500,
          maxDelay: 3600,
          duration: 86400n,
          owner: randomAddress(),
        },
      ];

      for (const config of hybrids) {
        // Verification depends on bucket capacity (and elapsed delay for the
        // delayed-flow one), neither of which this helper reads, so the
        // no-false-positive contract requires false.
        expect(
          await moduleCanCertainlyVerify(
            config,
            multiProvider,
            origin,
            destination,
          ),
        ).to.be.false;
      }
    });

    it('returns false for an aggregation containing a hybrid hook/ISM', async () => {
      // Accepted consequence of the no-false-positive contract: an aggregation
      // counts sub-results against its threshold, so a compliant aggregation
      // whose members include a hybrid still reports "cannot verify".
      const config: IsmConfig = {
        type: IsmType.AGGREGATION,
        threshold: 2,
        modules: [
          { type: IsmType.TEST_ISM },
          {
            type: IsmType.DELAYED_FLOW_ROUTER,
            thresholdBps: 500,
            maxDelay: 3600,
            duration: 86400n,
            owner: randomAddress(),
          },
        ],
      };

      const result = await moduleCanCertainlyVerify(
        config,
        multiProvider,
        origin,
        destination,
      );

      expect(result).to.be.false;
    });

    it('returns true for an empty blacklist', async () => {
      const config: BlacklistIsmConfig = {
        type: IsmType.BLACKLIST,
        owner: randomAddress(),
        blacklistedIds: [],
      };

      const result = await moduleCanCertainlyVerify(
        config,
        multiProvider,
        origin,
        destination,
      );

      expect(result).to.be.true;
    });
  });

  describe('moduleMatchesConfig', () => {
    it('returns false for the Sealevel-only routingMessageIdMultisigIsm without reading the module', async () => {
      const multiProvider = MultiProvider.createTestMultiProvider();
      const config: IsmConfig = {
        type: IsmType.ROUTING_MESSAGE_ID_MULTISIG,
        owner: randomAddress(),
        domains: {
          [TestChainName.test2]: {
            validators: [randomAddress()],
            threshold: 1,
          },
        },
      };
      // CAST: test double; the Sealevel-only type short-circuits before any
      // factory contract is read.
      const contractsDouble =
        {} as unknown as HyperlaneContracts<ProxyFactoryFactories>;

      const result = await moduleMatchesConfig(
        TestChainName.test1,
        randomAddress(),
        config,
        multiProvider,
        contractsDouble,
      );

      expect(result).to.be.false;
    });
  });

  describe('collectValidators', () => {
    const validatorA = randomAddress();
    const validatorB = randomAddress();
    const config: IsmConfig = {
      type: IsmType.ROUTING_MESSAGE_ID_MULTISIG,
      owner: randomAddress(),
      domains: {
        [TestChainName.test2]: {
          validators: [validatorA, validatorB],
          threshold: 1,
        },
      },
    };

    it('returns the validators of the origin domain for routingMessageIdMultisigIsm', () => {
      expect([
        ...collectValidators(TestChainName.test2, config),
      ]).to.have.members([validatorA, validatorB]);
    });

    it('returns an empty set when the origin is absent from routingMessageIdMultisigIsm', () => {
      expect(collectValidators(TestChainName.test1, config).size).to.equal(0);
    });
  });

  describe('offchainLookupRequestHash', () => {
    const request: OffchainLookupRequest = {
      urlTemplate:
        'https://ccs.example/callCommitments/getCallsFromRevealMessage',
      sender: '0x' + '03'.repeat(20),
      callData: '0x' + '11'.repeat(32),
      messageId: '0x' + '22'.repeat(32),
      originTxHash: '0x' + '33'.repeat(32),
      issuedAt: 1_700_000_000,
    };
    // Shared with the Rust relayer's `OffchainLookupRequest::signing_hash` test.
    const expected =
      '0x8ef3fe80017b834f4d5cbf461faa54a6180fad62f4eb0c575ba712679ff51ffb';

    it('matches the shared vector', () => {
      expect(offchainLookupRequestHash(request)).to.equal(expected);
    });

    it('accepts a mixed-case sender without a valid checksum', () => {
      expect(
        offchainLookupRequestHash({
          urlTemplate: request.urlTemplate,
          sender: '0x' + 'aB'.repeat(20),
          callData: request.callData,
          messageId: request.messageId,
          originTxHash: request.originTxHash,
          issuedAt: request.issuedAt,
        }),
      ).to.equal(
        offchainLookupRequestHash({
          urlTemplate: request.urlTemplate,
          sender: '0x' + 'ab'.repeat(20),
          callData: request.callData,
          messageId: request.messageId,
          originTxHash: request.originTxHash,
          issuedAt: request.issuedAt,
        }),
      );
    });

    interface Case {
      name: string;
      change: Partial<OffchainLookupRequest>;
    }
    const cases: Case[] = [
      {
        name: 'url template',
        change: {
          urlTemplate: 'https://ccs.example/callCommitments/calldata',
        },
      },
      { name: 'sender', change: { sender: '0x' + '04'.repeat(20) } },
      { name: 'call data', change: { callData: '0x' + '11'.repeat(33) } },
      { name: 'message id', change: { messageId: '0x' + '23'.repeat(32) } },
      {
        name: 'origin transaction hash',
        change: { originTxHash: '0x' + '34'.repeat(32) },
      },
      { name: 'issued at', change: { issuedAt: 1_700_000_001 } },
    ];
    for (const c of cases) {
      it(`signs the ${c.name}`, () => {
        expect(
          offchainLookupRequestHash({
            urlTemplate: c.change.urlTemplate ?? request.urlTemplate,
            sender: c.change.sender ?? request.sender,
            callData: c.change.callData ?? request.callData,
            messageId: c.change.messageId ?? request.messageId,
            originTxHash: c.change.originTxHash ?? request.originTxHash,
            issuedAt: c.change.issuedAt ?? request.issuedAt,
          }),
        ).to.not.equal(expected);
      });
    }
  });
});
