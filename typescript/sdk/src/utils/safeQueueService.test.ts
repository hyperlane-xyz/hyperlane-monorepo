import { OperationType } from '@safe-global/types-kit';
import { expect } from 'chai';
import { constants } from 'ethers';
import sinon from 'sinon';

import { SafeQueueService, SafeQueueServiceError } from './safeQueueService.js';

const gateway = 'https://api.safe.global';
const safe = '0x0000000000000000000000000000000000000001';
const owner = '0x0000000000000000000000000000000000000002';
const delegate = '0x00000000000000000000000000000000000000aa';
const safeTxHash = `0x${'11'.repeat(32)}`;
const signature = '0x1234';

const transactionData = {
  nonce: 3,
  to: owner,
  value: '9007199254740993',
  data: '0x',
  operation: OperationType.Call,
  safeTxGas: '0',
  baseGas: '0',
  gasPrice: '0',
  gasToken: constants.AddressZero,
  refundReceiver: constants.AddressZero,
};

const queuedTransaction = {
  ...transactionData,
  nonce: '3',
  safeTxHash,
  safe,
  chainId: '1',
  to: null,
  gasToken: null,
  refundReceiver: null,
  data: null,
  txHash: null,
  created: '2026-11-24T00:00:00Z',
  proposer: owner,
  proposedBy: null,
  proposedVia: 'OWNER',
  confirmations: [],
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

describe('SafeQueueService', () => {
  const service = new SafeQueueService(gateway, 1, 'test-api-key');
  let request: sinon.SinonStub<
    Parameters<typeof fetch>,
    ReturnType<typeof fetch>
  >;

  beforeEach(() => {
    request = sinon.stub(globalThis, 'fetch');
  });

  afterEach(() => request.restore());

  it('paginates pending results using the requested Safe and chain', async () => {
    request
      .onFirstCall()
      .resolves(
        jsonResponse({ results: [queuedTransaction], next: '?offset=1' }),
      );
    request.onSecondCall().resolves(
      jsonResponse({
        results: [
          {
            ...queuedTransaction,
            nonce: '4',
            operation: 2,
            proposer: null,
            proposedVia: 'UNKNOWN',
          },
        ],
        next: null,
      }),
    );

    const transactions = await service.getPendingTransactions(safe);

    const firstUrl = new URL(String(request.firstCall.args[0]));
    expect(firstUrl.pathname).to.equal(
      '/queue/api/v1/multisig-transactions/queue',
    );
    expect(firstUrl.searchParams.get('safes')).to.equal(`${safe}:1`);
    expect(firstUrl.searchParams.get('limit')).to.equal('100');
    expect(firstUrl.searchParams.get('offset')).to.equal('0');
    const secondUrl = new URL(String(request.secondCall.args[0]));
    expect(secondUrl.searchParams.get('offset')).to.equal('1');
    expect(transactions.map((transaction) => transaction.nonce)).to.deep.equal([
      '3',
      '4',
    ]);
    expect(transactions[1]).to.include({
      operation: 2,
      proposer: null,
      proposedVia: 'UNKNOWN',
    });
    expect(transactions[0]).to.include({
      to: constants.AddressZero,
      gasToken: constants.AddressZero,
      refundReceiver: constants.AddressZero,
      data: '0x',
      value: '9007199254740993',
    });
  });

  it('uses the per-Safe endpoint to include stale unexecuted proposals', async () => {
    request.resolves(jsonResponse({ results: [], next: null }));

    await service.getPendingTransactions(safe, { includeStale: true });

    const url = new URL(String(request.firstCall.args[0]));
    expect(url.pathname).to.equal(
      `/queue/api/v1/safes/${safe}/multisig-transactions`,
    );
    expect(url.searchParams.get('chainId')).to.equal('1');
    expect(url.searchParams.get('executed')).to.equal('false');
  });

  it('allocates one above the highest pending nonce or uses the on-chain nonce for an empty queue', async () => {
    request
      .onFirstCall()
      .resolves(
        jsonResponse({ results: [queuedTransaction], next: '?offset=1' }),
      );
    request.onSecondCall().resolves(jsonResponse({ results: [], next: null }));
    const currentNonce = sinon.stub().resolves(8);

    expect(await service.getNextNonce(safe, currentNonce)).to.equal('4');
    expect(currentNonce.called).to.equal(false);
    const url = new URL(String(request.firstCall.args[0]));
    expect(url.searchParams.get('nonceOrder')).to.equal('desc');
    expect(url.searchParams.get('limit')).to.equal('1');
    expect(await service.getNextNonce(safe, currentNonce)).to.equal('8');
  });

  it('posts the Queue proposal body and validates the hash returned by Safe', async () => {
    request.resolves(jsonResponse({ safeTxHash }, 201));

    await service.proposeTransaction({
      safeAddress: safe,
      safeTransactionData: transactionData,
      safeTxHash,
      senderAddress: owner,
      senderSignature: signature,
    });

    const [rawUrl, options] = request.firstCall.args;
    expect(String(rawUrl)).to.equal(
      `${gateway}/queue/api/v1/multisig-transactions`,
    );
    expect(options?.method).to.equal('POST');
    expect(new Headers(options?.headers).get('Authorization')).to.equal(
      'Bearer test-api-key',
    );
    expect(JSON.parse(String(options?.body))).to.deep.equal({
      ...transactionData,
      chainId: 1,
      safe,
      signatures: [signature],
    });
  });

  it('treats a conflict as a successful retry only when the matching proposal exists', async () => {
    request.onFirstCall().resolves(jsonResponse({ detail: 'duplicate' }, 409));
    request.onSecondCall().resolves(
      jsonResponse({
        ...queuedTransaction,
        confirmations: [
          {
            owner,
            signature,
            signatureType: 'EOA',
            created: queuedTransaction.created,
          },
        ],
      }),
    );
    request.onThirdCall().resolves(jsonResponse({ detail: 'duplicate' }, 409));
    request.onCall(3).resolves(jsonResponse({ detail: 'not found' }, 404));
    const proposal = {
      safeAddress: safe,
      safeTransactionData: transactionData,
      safeTxHash,
      senderAddress: owner,
      senderSignature: signature,
    };

    await service.proposeTransaction(proposal);
    expect(String(request.secondCall.args[0])).to.equal(
      `${gateway}/queue/api/v1/multisig-transactions/${safeTxHash}`,
    );

    try {
      await service.proposeTransaction(proposal);
      expect.fail('Expected the unresolved conflict to reject');
    } catch (error) {
      expect(error).to.be.instanceOf(SafeQueueServiceError);
      expect(error).to.include({ status: 409, isRecoverable: false });
    }
  });

  it('submits the new owner signature separately when another owner already proposed the transaction', async () => {
    request.onFirstCall().resolves(jsonResponse({ detail: 'duplicate' }, 409));
    request.onSecondCall().resolves(jsonResponse(queuedTransaction));
    request.onThirdCall().resolves(jsonResponse([], 201));

    await service.proposeTransaction({
      safeAddress: safe,
      safeTransactionData: transactionData,
      safeTxHash,
      senderAddress: '0x0000000000000000000000000000000000000003',
      senderSignature: signature,
    });

    const [url, options] = request.thirdCall.args;
    expect(String(url)).to.equal(
      `${gateway}/queue/api/v1/multisig-transactions/${safeTxHash}/signatures`,
    );
    expect(options?.method).to.equal('POST');
    expect(JSON.parse(String(options?.body))).to.deep.equal({
      signatures: [signature],
    });
  });

  it('accepts a delegate retry without trying to record a confirmation', async () => {
    request.onFirstCall().resolves(jsonResponse({ detail: 'duplicate' }, 409));
    request.onSecondCall().resolves(
      jsonResponse({
        ...queuedTransaction,
        proposedVia: 'DELEGATE',
        proposedBy: delegate,
      }),
    );

    await service.proposeTransaction({
      safeAddress: safe,
      safeTransactionData: transactionData,
      safeTxHash,
      senderAddress: delegate,
      senderSignature: signature,
    });

    expect(request.callCount).to.equal(2);
  });

  it('checks chain and Safe scope against current owners for delegate proposals', async () => {
    const delegations = [
      { delegate, delegator: owner, chainId: '10', safe },
      { delegate, delegator: safe, chainId: '1', safe },
      { delegate, delegator: owner, chainId: '1', safe: owner },
    ];
    request
      .onFirstCall()
      .resolves(jsonResponse({ results: delegations, next: null }));
    request.onSecondCall().resolves(
      jsonResponse({
        results: [
          ...delegations,
          { delegate, delegator: owner, chainId: null, safe: null },
        ],
        next: null,
      }),
    );

    expect(await service.isDelegate(delegate, safe, [owner])).to.equal(false);
    expect(
      await service.isDelegate(delegate.replace('aa', 'AA'), safe, [owner]),
    ).to.equal(true);
    const url = new URL(String(request.firstCall.args[0]));
    expect(url.pathname).to.equal('/queue/api/v1/delegates');
    expect(url.searchParams.get('delegate')).to.equal(delegate);
    expect(url.searchParams.has('chainId')).to.equal(false);
    expect(url.searchParams.has('safe')).to.equal(false);
  });

  it('deletes by hash using only the signed Queue delete request', async () => {
    request.resolves(new Response(null, { status: 204 }));

    await service.deleteTransaction(safeTxHash, signature);

    const [rawUrl, options] = request.firstCall.args;
    expect(String(rawUrl)).to.equal(
      `${gateway}/queue/api/v1/multisig-transactions/${safeTxHash}`,
    );
    expect(options?.method).to.equal('DELETE');
    expect(JSON.parse(String(options?.body))).to.deep.equal({ signature });
  });
});
