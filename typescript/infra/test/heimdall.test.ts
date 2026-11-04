import { expect } from 'chai';

import { requestHeimdallSafeTxRefresh } from '../src/utils/heimdall.js';

describe('Heimdall utils', () => {
  it('requests an exact Safe transaction refresh with CSRF headers', async () => {
    let requestedUrl: string | undefined;
    let requestedInit: RequestInit | undefined;
    const fetchFn = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      requestedUrl =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      requestedInit = init;
      return new Response(
        JSON.stringify({
          canonicalUrl: '/txs/safe/ethereum/0xhash',
        }),
        {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    };

    const canonicalUrl = await requestHeimdallSafeTxRefresh({
      baseUrl: 'https://heimdall.example/path',
      chainName: 'ethereum mainnet',
      safeAddress: '0xSafe',
      safeTxHash: '0xHash/with/slashes',
      fetchFn,
    });

    expect(requestedUrl).to.equal(
      'https://heimdall.example/api/v1/multisigs/ethereum%20mainnet/0xSafe/txs/0xHash%2Fwith%2Fslashes/refresh',
    );
    expect(requestedInit?.method).to.equal('POST');
    expect(new Headers(requestedInit?.headers).get('Origin')).to.equal(
      'https://heimdall.example',
    );
    expect(new Headers(requestedInit?.headers).get('X-Heimdall-CSRF')).to.equal(
      '1',
    );
    expect(requestedInit?.signal).to.be.instanceOf(AbortSignal);
    expect(canonicalUrl).to.equal(
      'https://heimdall.example/txs/safe/ethereum/0xhash',
    );
  });

  it('retries a transaction that is not yet visible before succeeding', async () => {
    let attempts = 0;
    const retryDelays: number[] = [];
    const fetchFn = async (): Promise<Response> => {
      attempts += 1;
      return attempts === 1
        ? new Response(null, { status: 404 })
        : new Response(
            JSON.stringify({ canonicalUrl: '/txs/safe/ethereum/0xhash' }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          );
    };

    const canonicalUrl = await requestHeimdallSafeTxRefresh({
      baseUrl: 'https://heimdall.example',
      chainName: 'ethereum',
      safeAddress: '0xSafe',
      safeTxHash: '0xHash',
      fetchFn,
      sleepFn: async (ms) => {
        retryDelays.push(ms);
      },
    });

    expect(attempts).to.equal(2);
    expect(retryDelays).to.deep.equal([250]);
    expect(canonicalUrl).to.equal(
      'https://heimdall.example/txs/safe/ethereum/0xhash',
    );
  });

  it('rejects unsuccessful refresh requests after bounded retries', async () => {
    let attempts = 0;
    const fetchFn = async (): Promise<Response> => {
      attempts += 1;
      return new Response(null, { status: 503 });
    };

    try {
      await requestHeimdallSafeTxRefresh({
        baseUrl: 'https://heimdall.example',
        chainName: 'ethereum',
        safeAddress: '0xSafe',
        safeTxHash: '0xHash',
        fetchFn,
        sleepFn: async () => {},
      });
      throw new Error('Expected refresh request to reject');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).to.equal('Heimdall returned HTTP 503');
      }
    }
    expect(attempts).to.equal(3);
  });
});
