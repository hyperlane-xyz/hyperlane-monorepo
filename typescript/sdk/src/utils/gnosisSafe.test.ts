import { expect } from 'chai';
import sinon from 'sinon';
import Safe from '@safe-global/protocol-kit';

import { MultiProvider } from '../providers/MultiProvider.js';

import {
  getSafe,
  getSafeApiKitConfig,
  isSafeGlobalTxServiceUrl,
  normalizeSafeTxServiceUrl,
} from './gnosisSafe.js';

const safeAddress = '0x1234567890123456789012345678901234567890';
const safeProtocolKit = Safe as unknown as {
  init: (options: unknown) => Promise<Safe.default>;
};

function createMultiProviderWithoutSafeService(): MultiProvider {
  return {
    getEvmChainId: () => 12345,
    getChainMetadata: () => ({
      rpcUrls: [{ http: 'http://localhost:8545' }],
    }),
  } as unknown as MultiProvider;
}

async function expectRejection(
  promise: Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await promise;
    throw new Error('Expected promise to reject');
  } catch (error) {
    expect((error as Error).message).to.include(message);
  }
}

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

  describe('getSafe', () => {
    let safeInitStub: sinon.SinonStub;

    beforeEach(() => {
      safeInitStub = sinon
        .stub(safeProtocolKit, 'init')
        .resolves({} as Safe.default);
    });

    afterEach(() => {
      safeInitStub.restore();
    });

    it('throws by default when the Safe transaction service is unavailable', async () => {
      await expectRejection(
        getSafe(
          'testchain',
          createMultiProviderWithoutSafeService(),
          safeAddress,
        ),
        'must provide tx service url for testchain',
      );
      expect(safeInitStub.called).to.equal(false);
    });

    it('falls back only when unresolved Safe versions are explicitly allowed', async () => {
      await getSafe(
        'testchain',
        createMultiProviderWithoutSafeService(),
        safeAddress,
        undefined,
        { allowUnresolvedSafeVersion: true },
      );

      expect(safeInitStub.calledOnce).to.equal(true);
      const initConfig = safeInitStub.firstCall.args[0] as {
        contractNetworks: Record<
          string,
          { multiSendAddress: string; multiSendCallOnlyAddress: string }
        >;
      };
      expect(initConfig.contractNetworks['12345'].multiSendAddress).to.equal(
        safeAddress,
      );
      expect(
        initConfig.contractNetworks['12345'].multiSendCallOnlyAddress,
      ).to.equal(safeAddress);
    });
  });
});
