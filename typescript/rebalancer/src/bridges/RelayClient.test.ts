import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';

import {
  RelayClient,
  RelayQuoteResponseSchema,
  RelayRequestError,
  RelayStatus,
  RelayTradeType,
} from './RelayClient.js';

chai.use(chaiAsPromised);

const requestId = `0x${'ab'.repeat(32)}`;
const address = '0x1111111111111111111111111111111111111111';
const request = {
  user: address,
  recipient: address,
  originChainId: 8453,
  destinationChainId: 99901,
  originCurrency: address,
  destinationCurrency: address,
  amount: '10000000',
  tradeType: RelayTradeType.ExactInput,
  slippageTolerance: '10',
};

function quoteResponse() {
  const currency = { chainId: 8453, address, decimals: 6 };
  return {
    requestId,
    steps: [
      {
        id: 'deposit',
        kind: 'transaction',
        requestId,
        items: [
          {
            data: {
              from: address,
              to: address,
              data: '0xdeadbeef',
              value: '0',
              chainId: 8453,
            },
          },
        ],
      },
    ],
    details: {
      sender: address,
      recipient: address,
      currencyIn: { currency, amount: '10000000', minimumAmount: '10000000' },
      currencyOut: {
        currency: { ...currency, chainId: 99901 },
        amount: '9970000',
        minimumAmount: '9960000',
      },
      timeEstimate: 1,
    },
  };
}

describe('RelayClient', () => {
  afterEach(() => sinon.restore());

  it('uses quote v2 and explicitly disables signature and deposit-address flows', async () => {
    const fetch = sinon
      .stub(globalThis, 'fetch')
      .resolves(new Response(JSON.stringify(quoteResponse())));
    await new RelayClient().quote(request);
    expect(fetch.firstCall.args[0]).to.equal('https://api.relay.link/quote/v2');
    const init = fetch.firstCall.args[1];
    expect(init?.headers).to.deep.equal({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init?.body))).to.deep.include({
      ...request,
      refundTo: request.user,
      explicitDeposit: true,
      latePaymentSlippageTolerance: '0',
      usePermit: false,
      useDepositAddress: false,
      useMulticallAuthorization: false,
    });
  });

  it('returns refunds to the source account when the recipient differs', async () => {
    const fetch = sinon
      .stub(globalThis, 'fetch')
      .resolves(new Response(JSON.stringify(quoteResponse())));
    const recipient = '0x2222222222222222222222222222222222222222';
    await new RelayClient().quote({ ...request, recipient });
    expect(JSON.parse(String(fetch.firstCall.args[1]?.body))).to.include({
      recipient,
      refundTo: request.user,
    });
  });

  it('passes an optional API key only in headers', async () => {
    const fetch = sinon.stub(globalThis, 'fetch').resolves(
      new Response(
        JSON.stringify({
          status: RelayStatus.Waiting,
          failReason: null,
          refundFailReason: null,
        }),
      ),
    );
    const result = await new RelayClient({ apiKey: 'test-key' }).getStatus(
      requestId,
    );
    expect(result.status).to.equal(RelayStatus.Waiting);
    expect(fetch.firstCall.args[0]).to.equal(
      `https://api.relay.link/intents/status/v3?requestId=${requestId}`,
    );
    expect(fetch.firstCall.args[1]?.headers).to.deep.include({
      'x-api-key': 'test-key',
    });
  });

  it('rejects signature steps, multiple transactions and invalid response amounts', () => {
    const signature = quoteResponse();
    signature.steps[0].kind = 'signature';
    expect(() => RelayQuoteResponseSchema.parse(signature)).to.throw();
    const multiple = quoteResponse();
    multiple.steps[0].items.push(multiple.steps[0].items[0]);
    expect(() => RelayQuoteResponseSchema.parse(multiple)).to.throw();
    const amount = quoteResponse();
    amount.details.currencyOut.minimumAmount = '-1';
    expect(() => RelayQuoteResponseSchema.parse(amount)).to.throw();
  });

  it('propagates structured route errors without logging credentials or payloads', async () => {
    sinon.stub(globalThis, 'fetch').resolves(
      new Response(
        JSON.stringify({
          errorCode: 'NO_SWAP_ROUTES_FOUND',
          message: 'ignored API response body',
        }),
        { status: 400 },
      ),
    );
    await expect(
      new RelayClient({ apiKey: 'test-key' }).quote(request),
    ).to.be.rejectedWith(RelayRequestError, 'NO_SWAP_ROUTES_FOUND');
  });

  it('bounds a response body that never resolves', async () => {
    const response = new Response('{}');
    sinon.stub(response, 'json').returns(new Promise(() => undefined));
    sinon.stub(globalThis, 'fetch').resolves(response);
    await expect(
      new RelayClient({ requestTimeoutMs: 10 }).getStatus(requestId),
    ).to.be.rejectedWith('timed out');
  });

  it('rejects unsafe API URLs before a request', () => {
    for (const apiUrl of [
      'http://relay.invalid',
      'https://user:password@relay.invalid',
      'https://relay.invalid?key=test',
    ]) {
      expect(() => new RelayClient({ apiUrl })).to.throw();
    }
  });
});
