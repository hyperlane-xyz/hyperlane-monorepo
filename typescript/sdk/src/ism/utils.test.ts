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
});
