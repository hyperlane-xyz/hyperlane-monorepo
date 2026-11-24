import { expect } from 'chai';
import sinon from 'sinon';
import Safe from '@safe-global/protocol-kit';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';

import {
  getSafe,
  getSafeApiKitConfig,
  getSafeQueueService,
  getSafeService,
  isSafeGlobalTxServiceUrl,
  normalizeSafeTxServiceUrl,
  safeApiKeyRequired,
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
  describe('safeApiKeyRequired', () => {
    it('only sends the Safe API key to Safe-owned hostnames', () => {
      expect(
        safeApiKeyRequired('https://api.safe.global/tx-service/base'),
      ).to.equal(true);
      expect(
        safeApiKeyRequired('https://api.5afe.dev/tx-service/base'),
      ).to.equal(true);
      expect(
        safeApiKeyRequired('http://api.safe.global/tx-service/base'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('https://api.safe.global.example/tx-service/base'),
      ).to.equal(false);
      expect(safeApiKeyRequired('https://example.org/safe.global')).to.equal(
        false,
      );
    });
  });

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

    it('keeps staging credentials on the staging gateway', () => {
      const config = getSafeApiKitConfig(
        8453,
        'https://api.5afe.dev/tx-service/base',
        'safe-api-key',
      );

      expect(config.apiKey).to.equal('safe-api-key');
      expect(config.txServiceUrl).to.equal(
        'https://api.5afe.dev/tx-service/base/api',
      );
    });
  });

  describe('Safe service selection', () => {
    function multiProviderWithTxService(
      txServiceUrl: string,
      chainId = 8453,
    ): MultiProvider {
      return new MultiProvider({
        testchain: {
          name: 'testchain',
          protocol: ProtocolType.Ethereum,
          chainId,
          domainId: chainId,
          rpcUrls: [{ http: 'http://localhost:8545' }],
          gnosisSafeTransactionServiceUrl: txServiceUrl,
          gnosisSafeApiKey: 'test-api-key',
        },
      });
    }

    it('uses the canonical HTTPS origin of the configured Safe gateway', async () => {
      const request = sinon
        .stub(globalThis, 'fetch')
        .resolves(new Response(JSON.stringify({ next: null, results: [] })));
      try {
        const service = getSafeQueueService(
          'testchain',
          multiProviderWithTxService(
            'http://api.5afe.dev:8080/tx-service/base/api/',
          ),
        );
        expect(service).to.not.equal(undefined);
        await service?.getPendingTransactions(safeAddress);

        const url = new URL(String(request.firstCall.args[0]));
        expect(url.origin).to.equal('https://api.5afe.dev');
        expect(url.searchParams.get('safes')).to.equal(`${safeAddress}:8453`);
      } finally {
        request.restore();
      }
    });

    it('leaves custom and self-hosted transaction service URLs on their existing client', () => {
      for (const url of [
        'https://safe.example/tx-service/base',
        'http://127.0.0.1:2496',
      ]) {
        expect(
          getSafeQueueService('testchain', multiProviderWithTxService(url)),
        ).to.equal(undefined);
      }
    });

    it('uses the configured transaction service for chains missing from API Kit', () => {
      expect(() =>
        getSafeService(
          'testchain',
          multiProviderWithTxService(
            'https://api.safe.global/tx-service/testchain',
            31347,
          ),
        ),
      ).not.to.throw();
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
