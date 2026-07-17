import { expect } from 'chai';
import { pino } from 'pino';
import sinon from 'sinon';

import {
  SwapsXyzClient,
  SwapsXyzRequestError,
  isSwapsXyzTerminalError,
  type SwapsXyzActionRequest,
} from './SwapsXyzClient.js';

const logger = pino({ level: 'silent' });

type FetchStub = sinon.SinonStub<
  Parameters<typeof globalThis.fetch>,
  ReturnType<typeof globalThis.fetch>
>;

function makeResponse(options: {
  status?: number;
  statusText?: string;
  body?: unknown;
}): Response {
  const status = options.status ?? 200;
  return new Response(JSON.stringify(options.body ?? {}), {
    status,
    statusText: options.statusText ?? 'OK',
    headers: { 'content-type': 'application/json' },
  });
}

function getRequest(
  fetchStub: FetchStub,
  callIndex = 0,
): { url: string; init: RequestInit } {
  const call = fetchStub.getCall(callIndex);
  if (!call) throw new Error(`Missing fetch call ${callIndex}`);
  const [input, init] = call.args;
  if (typeof input !== 'string') throw new Error('Expected string fetch URL');
  if (!init) throw new Error('Expected fetch request init');
  return { url: input, init };
}

function actionRequest(): SwapsXyzActionRequest {
  return {
    actionType: 'swap-action',
    sender: '0xabc',
    srcChainId: 1,
    srcToken: '0x1111',
    dstChainId: 8453,
    dstToken: '0x2222',
    slippage: 50,
    amount: '1000000',
    swapDirection: 'exact-amount-in',
  };
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected promise to reject');
}

describe('SwapsXyzClient', () => {
  let client: SwapsXyzClient;
  let fetchStub: FetchStub;

  beforeEach(() => {
    client = new SwapsXyzClient(
      { apiKey: 'test-key', defaultSlippageBps: 50 },
      logger,
    );
    fetchStub = sinon.stub(globalThis, 'fetch');
  });

  afterEach(() => {
    sinon.restore();
  });

  it('sends x-api-key on every endpoint request', async () => {
    fetchStub.callsFake(async () => makeResponse({ body: { txId: 'tx-1' } }));

    await client.getAction(actionRequest());
    await client.getStatus({ txId: 'tx-1' });
    await client.registerTxs([{ txId: 'tx-1', txHash: '0xabc' }]);

    expect(fetchStub.callCount).to.equal(3);
    for (let index = 0; index < fetchStub.callCount; index++) {
      const { init } = getRequest(fetchStub, index);
      expect(new Headers(init.headers).get('x-api-key')).to.equal('test-key');
    }
  });

  it('bounds each request with an AbortSignal timeout', async () => {
    fetchStub.resolves(makeResponse({ body: { txId: 'tx-1' } }));
    await client.getAction(actionRequest());

    const { init } = getRequest(fetchStub);
    expect(init.signal).to.be.instanceOf(AbortSignal);
  });

  it('builds /getAction query params and skips undefined values', async () => {
    fetchStub.resolves(makeResponse({ body: { txId: 'tx-1' } }));
    await client.getAction({
      ...actionRequest(),
      srcChainId: 8453,
      dstChainId: 42161,
      slippage: 100,
      recipient: undefined,
    });

    const { url } = getRequest(fetchStub);
    const parsedUrl = new URL(url);
    expect(parsedUrl.origin + parsedUrl.pathname).to.equal(
      'https://api-v2.swaps.xyz/api/getAction',
    );
    expect(parsedUrl.searchParams.get('srcChainId')).to.equal('8453');
    expect(parsedUrl.searchParams.get('dstChainId')).to.equal('42161');
    expect(parsedUrl.searchParams.get('swapDirection')).to.equal(
      'exact-amount-in',
    );
    expect(parsedUrl.searchParams.get('slippage')).to.equal('100');
    expect(parsedUrl.searchParams.has('recipient')).to.equal(false);
  });

  it('honors apiUrl override and strips its trailing slash', async () => {
    const customClient = new SwapsXyzClient(
      { apiKey: 'test-key', apiUrl: 'https://example.test/api/' },
      logger,
    );
    fetchStub.resolves(makeResponse({ body: { status: 'pending' } }));

    await customClient.getStatus({ txId: 'tx-1' });

    const { url } = getRequest(fetchStub);
    expect(url.startsWith('https://example.test/api/getStatus?')).to.equal(
      true,
    );
  });

  it('getStatus throws synchronously without txHash or txId', () => {
    expect(() => client.getStatus({})).to.throw('txHash or txId');
    expect(fetchStub.callCount).to.equal(0);
  });

  it('parses the error envelope and exposes its code', async () => {
    fetchStub.resolves(
      makeResponse({
        status: 400,
        statusText: 'Bad Request',
        body: {
          success: false,
          error: { code: 'NO_AVAILABLE_ROUTE', message: 'no route' },
        },
      }),
    );

    const error = await captureError(client.getAction(actionRequest()));
    expect(error).to.be.instanceOf(SwapsXyzRequestError);
    if (!(error instanceof SwapsXyzRequestError)) {
      throw new Error('Expected SwapsXyzRequestError');
    }
    expect(error.code).to.equal('NO_AVAILABLE_ROUTE');
    expect(error.message).to.include('no route');
  });

  it('does not retry terminal NO_AVAILABLE_ROUTE errors', async () => {
    fetchStub.resolves(
      makeResponse({
        status: 400,
        body: { error: { code: 'NO_AVAILABLE_ROUTE' } },
      }),
    );

    const error = await captureError(client.getAction(actionRequest()));
    expect(error).to.be.instanceOf(SwapsXyzRequestError);
    expect(fetchStub.callCount).to.equal(1);
  });

  it('retries transient errors and succeeds on the third attempt', async function () {
    this.timeout(10_000);
    fetchStub
      .onCall(0)
      .resolves(makeResponse({ status: 500, statusText: 'Internal' }));
    fetchStub
      .onCall(1)
      .resolves(makeResponse({ status: 502, statusText: 'Bad Gateway' }));
    fetchStub.onCall(2).resolves(makeResponse({ body: { txId: 'tx-1' } }));

    const response = await client.getAction(actionRequest());
    expect(response.txId).to.equal('tx-1');
    expect(fetchStub.callCount).to.equal(3);
  });

  it('classifies 408 as retriable and request errors as terminal', () => {
    expect(
      isSwapsXyzTerminalError(
        new SwapsXyzRequestError('timeout', 408, 'Request Timeout'),
      ),
    ).to.equal(false);
    expect(
      isSwapsXyzTerminalError(
        new SwapsXyzRequestError(
          'unauthorized',
          401,
          'Unauthorized',
          'INVALID_API_KEY',
        ),
      ),
    ).to.equal(true);
    expect(
      isSwapsXyzTerminalError(
        new SwapsXyzRequestError(
          'unsupported',
          400,
          'Bad Request',
          'UNSUPPORTED_SWAP_DIRECTION',
        ),
      ),
    ).to.equal(true);
  });

  it('registerTxs posts a JSON body with content-type', async () => {
    fetchStub.resolves(
      makeResponse({ body: [{ success: true, error: null }] }),
    );
    const entries = [{ txId: 'tx-1', txHash: '0xabc' }];

    const results = await client.registerTxs(entries);

    const { url, init } = getRequest(fetchStub);
    expect(url).to.equal('https://api-v2.swaps.xyz/api/registerTxs');
    expect(init.method).to.equal('POST');
    expect(init.body).to.equal(JSON.stringify(entries));
    expect(new Headers(init.headers).get('content-type')).to.equal(
      'application/json',
    );
    const [result] = results;
    if (!result) throw new Error('Expected registration result');
    expect(result.success).to.equal(true);
  });
});
