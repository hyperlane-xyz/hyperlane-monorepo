import { expect } from 'chai';
import sinon from 'sinon';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';

import {
  FeeQuotingNoQuoteAvailableError,
  FeeQuotingV2Client,
  type FeeQuotingV2IgpParams,
  type FeeQuotingV2WarpParams,
} from './client.js';
import {
  type EthereumQuoteV2Entry,
  NO_QUOTE_AVAILABLE_ERROR,
  NoQuoteAvailableReason,
  QUOTE_V2_BASE_PATH,
  QuoteV2Endpoint,
  type SealevelQuoteV2Entry,
} from './types.js';

const BASE_URL = 'https://fee-quoting.example';
const API_KEY = 'test-api-key';

const WARP_PARAMS: FeeQuotingV2WarpParams = {
  origin: 'solanamainnet',
  router: '11111111111111111111111111111111',
  destination: 8453,
  salt: `0x${'00'.repeat(32)}`,
  recipient: `0x${'ff'.repeat(32)}`,
  targetRouter: `0x${'aa'.repeat(32)}`,
  txSubmitter: '11111111111111111111111111111111',
};

const IGP_PARAMS: FeeQuotingV2IgpParams = {
  origin: 'solanamainnet',
  router: '11111111111111111111111111111111',
  destination: 8453,
  salt: `0x${'00'.repeat(32)}`,
  txSubmitter: '11111111111111111111111111111111',
};

const SEALEVEL_QUOTE: SealevelQuoteV2Entry = {
  protocol: ProtocolType.Sealevel,
  quoter: '11111111111111111111111111111111',
  issuedAt: 1700000000,
  expiry: 1700003600,
  details: {
    domainId: 1399811149,
    signedQuote: {
      context: `0x${'11'.repeat(44)}`,
      data: `0x${'22'.repeat(8)}`,
      issuedAt: `0x${'33'.repeat(6)}`,
      expiry: `0x${'44'.repeat(6)}`,
      clientSalt: `0x${'55'.repeat(32)}`,
      signature: `0x${'66'.repeat(65)}`,
    },
  },
};

const ETHEREUM_QUOTE: EthereumQuoteV2Entry = {
  protocol: ProtocolType.Ethereum,
  quoter: `0x${'11'.repeat(20)}`,
  issuedAt: 1700000000,
  expiry: 1700003600,
  details: {
    quote: {
      context: `0x${'22'.repeat(32)}`,
      data: `0x${'33'.repeat(8)}`,
      issuedAt: 1700000000,
      expiry: 1700003600,
      salt: `0x${'44'.repeat(32)}`,
      submitter: `0x${'55'.repeat(20)}`,
    },
    signature: `0x${'66'.repeat(65)}`,
  },
};

function makeResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('FeeQuotingV2Client', () => {
  let fetchStub: sinon.SinonStub;

  beforeEach(() => {
    fetchStub = sinon.stub(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchStub.restore();
  });

  describe('getWarpQuote', () => {
    it('returns the quote on success and authorizes via Bearer header', async () => {
      fetchStub.resolves(makeResponse(200, { quote: SEALEVEL_QUOTE }));

      const client = new FeeQuotingV2Client({
        baseUrl: BASE_URL,
        apiKey: API_KEY,
      });
      const quote = await client.getWarpQuote(WARP_PARAMS);

      expect(quote).to.deep.equal(SEALEVEL_QUOTE);
      expect(fetchStub.calledOnce).to.be.true;

      const [url, init] = fetchStub.firstCall.args as [string, RequestInit];
      expect(url).to.include(
        `${BASE_URL}${QUOTE_V2_BASE_PATH}/${QuoteV2Endpoint.Warp}?`,
      );
      expect(url).to.include(`origin=${WARP_PARAMS.origin}`);
      expect(url).to.include(`recipient=${WARP_PARAMS.recipient}`);
      expect(url).to.include(`targetRouter=${WARP_PARAMS.targetRouter}`);
      expect(url).to.include(`txSubmitter=${WARP_PARAMS.txSubmitter}`);

      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).to.equal(`Bearer ${API_KEY}`);
    });

    it('strips trailing slash from baseUrl', async () => {
      fetchStub.resolves(makeResponse(200, { quote: SEALEVEL_QUOTE }));

      const client = new FeeQuotingV2Client({
        baseUrl: `${BASE_URL}/`,
        apiKey: API_KEY,
      });
      await client.getWarpQuote(WARP_PARAMS);

      const [url] = fetchStub.firstCall.args as [string];
      expect(url.startsWith(`${BASE_URL}${QUOTE_V2_BASE_PATH}`)).to.be.true;
      expect(url.startsWith(`${BASE_URL}/${QUOTE_V2_BASE_PATH}`)).to.be.false;
    });

    it('throws FeeQuotingNoQuoteAvailableError on 404 with the expected body', async () => {
      fetchStub.resolves(
        makeResponse(404, {
          error: NO_QUOTE_AVAILABLE_ERROR,
          reason: NoQuoteAvailableReason.NotConfigured,
          detail: 'No fee account configured for solanamainnet → 8453',
        }),
      );

      const client = new FeeQuotingV2Client({
        baseUrl: BASE_URL,
        apiKey: API_KEY,
      });

      try {
        await client.getWarpQuote(WARP_PARAMS);
        expect.fail('expected throw');
      } catch (err) {
        expect(err).to.be.instanceOf(FeeQuotingNoQuoteAvailableError);
        const typed = err as FeeQuotingNoQuoteAvailableError;
        expect(typed.reason).to.equal(NoQuoteAvailableReason.NotConfigured);
        expect(typed.detail).to.equal(
          'No fee account configured for solanamainnet → 8453',
        );
      }
    });

    it('throws a generic Error on 404 without the no_quote_available body', async () => {
      fetchStub.resolves(makeResponse(404, { message: 'route not found' }));

      const client = new FeeQuotingV2Client({
        baseUrl: BASE_URL,
        apiKey: API_KEY,
      });

      try {
        await client.getWarpQuote(WARP_PARAMS);
        expect.fail('expected throw');
      } catch (err) {
        expect(err).to.not.be.instanceOf(FeeQuotingNoQuoteAvailableError);
        expect((err as Error).message).to.include('route not found');
      }
    });

    it('throws on non-2xx, non-404 with the server message', async () => {
      fetchStub.resolves(makeResponse(500, { message: 'upstream RPC error' }));

      const client = new FeeQuotingV2Client({
        baseUrl: BASE_URL,
        apiKey: API_KEY,
      });

      try {
        await client.getWarpQuote(WARP_PARAMS);
        expect.fail('expected throw');
      } catch (err) {
        expect((err as Error).message).to.include('500');
        expect((err as Error).message).to.include('upstream RPC error');
      }
    });

    it('throws on a 200 with an empty body rather than returning undefined', async () => {
      fetchStub.resolves(makeResponse(200, {}));

      const client = new FeeQuotingV2Client({
        baseUrl: BASE_URL,
        apiKey: API_KEY,
      });

      try {
        await client.getWarpQuote(WARP_PARAMS);
        expect.fail('expected throw');
      } catch (err) {
        expect(err).to.not.be.instanceOf(FeeQuotingNoQuoteAvailableError);
        expect((err as Error).message).to.include('malformed');
      }
    });

    it('throws on a 200 whose quote is missing required fields', async () => {
      fetchStub.resolves(
        makeResponse(200, {
          quote: { protocol: ProtocolType.Sealevel, quoter: 'x' },
        }),
      );

      const client = new FeeQuotingV2Client({
        baseUrl: BASE_URL,
        apiKey: API_KEY,
      });

      try {
        await client.getWarpQuote(WARP_PARAMS);
        expect.fail('expected throw');
      } catch (err) {
        expect((err as Error).message).to.include('malformed');
      }
    });

    it('returns a valid EVM quote on success', async () => {
      fetchStub.resolves(makeResponse(200, { quote: ETHEREUM_QUOTE }));

      const client = new FeeQuotingV2Client({
        baseUrl: BASE_URL,
        apiKey: API_KEY,
      });
      const quote = await client.getWarpQuote(WARP_PARAMS);

      expect(quote).to.deep.equal(ETHEREUM_QUOTE);
    });

    it('throws on an EVM 200 whose details.quote is empty', async () => {
      fetchStub.resolves(
        makeResponse(200, {
          quote: {
            ...ETHEREUM_QUOTE,
            details: { quote: {}, signature: ETHEREUM_QUOTE.details.signature },
          },
        }),
      );

      const client = new FeeQuotingV2Client({
        baseUrl: BASE_URL,
        apiKey: API_KEY,
      });

      try {
        await client.getWarpQuote(WARP_PARAMS);
        expect.fail('expected throw');
      } catch (err) {
        expect((err as Error).message).to.include('malformed');
      }
    });

    it('throws on an EVM 200 with a non-hex signature', async () => {
      fetchStub.resolves(
        makeResponse(200, {
          quote: {
            ...ETHEREUM_QUOTE,
            details: {
              quote: ETHEREUM_QUOTE.details.quote,
              signature: 'nothex',
            },
          },
        }),
      );

      const client = new FeeQuotingV2Client({
        baseUrl: BASE_URL,
        apiKey: API_KEY,
      });

      try {
        await client.getWarpQuote(WARP_PARAMS);
        expect.fail('expected throw');
      } catch (err) {
        expect((err as Error).message).to.include('malformed');
      }
    });

    it('throws on an SVM 200 with a wrong-length signature', async () => {
      fetchStub.resolves(
        makeResponse(200, {
          quote: {
            ...SEALEVEL_QUOTE,
            details: {
              ...SEALEVEL_QUOTE.details,
              signedQuote: {
                ...SEALEVEL_QUOTE.details.signedQuote,
                signature: `0x${'66'.repeat(10)}`,
              },
            },
          },
        }),
      );

      const client = new FeeQuotingV2Client({
        baseUrl: BASE_URL,
        apiKey: API_KEY,
      });

      try {
        await client.getWarpQuote(WARP_PARAMS);
        expect.fail('expected throw');
      } catch (err) {
        expect((err as Error).message).to.include('malformed');
      }
    });

    it('throws on an SVM 200 with a non-hex context', async () => {
      fetchStub.resolves(
        makeResponse(200, {
          quote: {
            ...SEALEVEL_QUOTE,
            details: {
              ...SEALEVEL_QUOTE.details,
              signedQuote: {
                ...SEALEVEL_QUOTE.details.signedQuote,
                context: 'nothex',
              },
            },
          },
        }),
      );

      const client = new FeeQuotingV2Client({
        baseUrl: BASE_URL,
        apiKey: API_KEY,
      });

      try {
        await client.getWarpQuote(WARP_PARAMS);
        expect.fail('expected throw');
      } catch (err) {
        expect((err as Error).message).to.include('malformed');
      }
    });
  });

  describe('getIgpQuote', () => {
    it('hits the igp endpoint with the expected params', async () => {
      fetchStub.resolves(makeResponse(200, { quote: SEALEVEL_QUOTE }));

      const client = new FeeQuotingV2Client({
        baseUrl: BASE_URL,
        apiKey: API_KEY,
      });
      const quote = await client.getIgpQuote(IGP_PARAMS);

      expect(quote).to.deep.equal(SEALEVEL_QUOTE);

      const [url] = fetchStub.firstCall.args as [string];
      expect(url).to.include(`${QUOTE_V2_BASE_PATH}/${QuoteV2Endpoint.Igp}?`);
      expect(url).to.include(`router=${IGP_PARAMS.router}`);
      expect(url).to.include(`txSubmitter=${IGP_PARAMS.txSubmitter}`);
      // IGP variant does NOT send `recipient` or `targetRouter`
      expect(url).to.not.include('recipient=');
      expect(url).to.not.include('targetRouter=');
    });
  });
});
