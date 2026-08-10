import { expect } from 'chai';

import { formatMessage, messageId } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { randomAddress } from '../test/testUtils.js';

import { BlacklistIsmConfig, IsmType } from './types.js';
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
