import { expect } from 'chai';

import {
  getSafeApiKitConfig,
  isSafeGlobalTxServiceUrl,
  normalizeSafeTxServiceUrl,
} from './gnosisSafe.js';

describe('gnosisSafe utils', () => {
  describe('normalizeSafeTxServiceUrl', () => {
    it('appends api to transaction service URLs', () => {
      expect(
        normalizeSafeTxServiceUrl('https://api.safe.global/tx-service/base'),
      ).to.equal('https://api.safe.global/tx-service/base/api');
    });

    it('preserves URLs that already end in api', () => {
      expect(
        normalizeSafeTxServiceUrl(
          'https://api.safe.global/tx-service/base/api/',
        ),
      ).to.equal('https://api.safe.global/tx-service/base/api');
    });
  });

  describe('isSafeGlobalTxServiceUrl', () => {
    it('matches the hosted Safe transaction service gateway', () => {
      expect(
        isSafeGlobalTxServiceUrl('https://api.safe.global/tx-service/base'),
      ).to.equal(true);
    });

    it('does not match custom Safe transaction service hosts', () => {
      expect(
        isSafeGlobalTxServiceUrl('https://safe-transaction-blast.safe.global'),
      ).to.equal(false);
    });
  });

  describe('getSafeApiKitConfig', () => {
    it('omits txServiceUrl for authenticated Safe global gateway requests', () => {
      const config = getSafeApiKitConfig(
        8453,
        'https://api.safe.global/tx-service/base',
        'safe-api-key',
      );

      expect(config.chainId).to.equal(8453n);
      expect(config.apiKey).to.equal('safe-api-key');
      expect(config.txServiceUrl).to.equal(undefined);
    });

    it('keeps txServiceUrl for custom services', () => {
      const config = getSafeApiKitConfig(
        81457,
        'https://safe-transaction-blast.safe.global',
        'safe-api-key',
      );

      expect(config.chainId).to.equal(81457n);
      expect(config.apiKey).to.equal('safe-api-key');
      expect(config.txServiceUrl).to.equal(
        'https://safe-transaction-blast.safe.global/api',
      );
    });
  });
});
