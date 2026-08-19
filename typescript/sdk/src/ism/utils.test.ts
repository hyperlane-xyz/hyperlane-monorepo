import { expect } from 'chai';

import { formatMessage, messageId } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { randomAddress } from '../test/testUtils.js';

import { BlacklistIsmConfig, IsmConfig, IsmType } from './types.js';
import { SAMPLE_VERIFY_ADDRESS, moduleCanCertainlyVerify } from './utils.js';

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
});
