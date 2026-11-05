import { expect } from 'chai';
import { BigNumber, errors as EthersError, ethers, Wallet } from 'ethers';
import sinon from 'sinon';

import { NonceRetryingSigner } from './NonceRetryingSigner.js';

function nonceExpiredError(): Error {
  const cause = new Error('nonce has already been used');
  Object.defineProperty(cause, 'code', { value: EthersError.NONCE_EXPIRED });
  const error = new Error('Blockchain error', { cause });
  Object.defineProperty(error, 'code', { value: EthersError.SERVER_ERROR });
  return error;
}

function transactionResponse(
  hash: string,
  from: string,
): ethers.providers.TransactionResponse {
  return {
    hash,
    confirmations: 0,
    from,
    nonce: 1,
    gasLimit: BigNumber.from(21_000),
    data: '0x',
    value: BigNumber.from(0),
    chainId: 1,
    wait: async () => {
      throw new Error('Not implemented for test');
    },
  };
}

async function getError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('Expected promise to reject');
}

describe('NonceRetryingSigner', () => {
  afterEach(() => sinon.restore());

  it('re-populates and re-signs an implicitly nonced transaction once', async () => {
    const wallet = Wallet.createRandom();
    const secondError = new Error('second submission failed');
    const sendTransaction = sinon
      .stub(wallet, 'sendTransaction')
      .onFirstCall()
      .rejects(nonceExpiredError())
      .onSecondCall()
      .rejects(secondError);
    const signer = new NonceRetryingSigner(wallet, 0);

    const error = await getError(
      signer.sendTransaction({ to: Wallet.createRandom().address }),
    );

    expect(error).to.equal(secondError);
    expect(sendTransaction.callCount).to.equal(2);
    expect(sendTransaction.secondCall.args[0].nonce).to.be.undefined;
  });

  it('does not retry a transaction with an explicit nonce', async () => {
    const wallet = Wallet.createRandom();
    const error = nonceExpiredError();
    const sendTransaction = sinon
      .stub(wallet, 'sendTransaction')
      .rejects(error);
    const signer = new NonceRetryingSigner(wallet, 0);

    expect(
      await getError(
        signer.sendTransaction({
          nonce: 7,
          to: Wallet.createRandom().address,
        }),
      ),
    ).to.equal(error);
    expect(sendTransaction.calledOnce).to.be.true;
  });

  it('does not retry when the rejected hash was accepted', async () => {
    const hash = `0x${'1'.repeat(64)}`;
    const provider = new ethers.providers.JsonRpcProvider();
    const wallet = Wallet.createRandom().connect(provider);
    const acceptedTransaction = transactionResponse(hash, wallet.address);
    const error = nonceExpiredError();
    Object.defineProperty(error, 'transactionHash', { value: hash });
    const sendTransaction = sinon
      .stub(wallet, 'sendTransaction')
      .rejects(error);
    const getTransaction = sinon
      .stub(provider, 'getTransaction')
      .resolves(acceptedTransaction);
    const signer = new NonceRetryingSigner(wallet, 0);

    expect(
      await signer.sendTransaction({ to: Wallet.createRandom().address }),
    ).to.equal(acceptedTransaction);
    expect(getTransaction.calledOnceWithExactly(hash)).to.be.true;
    expect(sendTransaction.calledOnce).to.be.true;
  });

  it('does not retry other transaction errors', async () => {
    const wallet = Wallet.createRandom();
    const error = new Error('insufficient funds');
    const sendTransaction = sinon
      .stub(wallet, 'sendTransaction')
      .rejects(error);
    const signer = new NonceRetryingSigner(wallet, 0);

    expect(
      await getError(
        signer.sendTransaction({ to: Wallet.createRandom().address }),
      ),
    ).to.equal(error);
    expect(sendTransaction.calledOnce).to.be.true;
  });

  it('keeps nonce retry behavior when connected', () => {
    const provider = new ethers.providers.JsonRpcProvider();
    const signer = new NonceRetryingSigner(Wallet.createRandom());

    const connected = signer.connect(provider);

    expect(connected).to.be.instanceOf(NonceRetryingSigner);
    expect(connected.provider).to.equal(provider);
  });
});
