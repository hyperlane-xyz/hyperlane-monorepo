import { expect } from 'chai';
import {
  ContractReceipt,
  ContractTransaction,
  Wallet,
  providers,
} from 'ethers';
import sinon from 'sinon';

import { TestChainName } from '../../../../consts/testChains.js';
import { randomAddress } from '../../../../test/testUtils.js';
import { MultiProvider } from '../../../MultiProvider.js';

import {
  EV5JsonRpcSubmissionError,
  EV5JsonRpcTxSubmitter,
} from './EV5JsonRpcTxSubmitter.js';

describe('EV5JsonRpcTxSubmitter', () => {
  const chain = TestChainName.test1;
  const chainId = 9913371;
  const props = { type: 'jsonRpc' as const, chain };
  const tx = { chainId, to: randomAddress() };

  let multiProvider: MultiProvider;
  let mainSigner: Wallet;
  let explicitSigner: Wallet;
  let connectedExplicitSigner: Wallet;
  let prepareTx: sinon.SinonStub;

  beforeEach(() => {
    const provider = new providers.JsonRpcProvider('http://127.0.0.1:8545');
    mainSigner = Wallet.createRandom().connect(provider);
    explicitSigner = Wallet.createRandom();
    connectedExplicitSigner = explicitSigner.connect(provider);
    multiProvider = MultiProvider.createTestMultiProvider({
      signer: mainSigner,
      provider,
    });

    sinon.stub(explicitSigner, 'connect').returns(connectedExplicitSigner);
    prepareTx = sinon
      .stub(multiProvider, 'prepareTx')
      .callsFake(async (_, request) => request);
  });

  afterEach(() => sinon.restore());

  it('uses an explicit signer instead of the MultiProvider signer', async () => {
    const response = transactionResponse('0x01');
    const receipt = transactionReceipt('0x01', 1);
    const explicitSend = sinon
      .stub(connectedExplicitSigner, 'sendTransaction')
      .resolves(response);
    const mainSend = sinon.stub(mainSigner, 'sendTransaction');
    sinon.stub(multiProvider, 'handleTx').resolves(receipt);

    const submitter = new EV5JsonRpcTxSubmitter(
      multiProvider,
      props,
      explicitSigner,
    );

    expect(await submitter.submit(tx)).to.deep.equal([receipt]);
    expect(explicitSend.calledOnce).to.equal(true);
    expect(mainSend.called).to.equal(false);
    expect(
      prepareTx.calledWith(chain, sinon.match.object, explicitSigner.address),
    ).to.equal(true);
  });

  it('uses the MultiProvider signer when no explicit signer is supplied', async () => {
    const response = transactionResponse('0x02');
    const receipt = transactionReceipt('0x02', 1);
    const mainSend = sinon
      .stub(mainSigner, 'sendTransaction')
      .resolves(response);
    sinon.stub(multiProvider, 'handleTx').resolves(receipt);

    const submitter = new EV5JsonRpcTxSubmitter(multiProvider, props);

    expect(await submitter.submit(tx)).to.deep.equal([receipt]);
    expect(mainSend.calledOnce).to.equal(true);
    expect(
      prepareTx.calledWith(chain, sinon.match.object, mainSigner.address),
    ).to.equal(true);
  });

  it('validates the complete batch before broadcasting', async () => {
    const explicitSend = sinon.stub(connectedExplicitSigner, 'sendTransaction');
    const submitter = new EV5JsonRpcTxSubmitter(
      multiProvider,
      props,
      explicitSigner,
    );

    let error: Error | undefined;
    try {
      await submitter.submit(tx, { ...tx, chainId: chainId + 1 });
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
    }

    expect(error?.message).to.include('does not match submitter chainId');
    expect(explicitSend.called).to.equal(false);
  });

  it('retains confirmed receipts and a pending hash on partial failure', async () => {
    const firstResponse = transactionResponse('0x03');
    const secondResponse = transactionResponse('0x04');
    const firstReceipt = transactionReceipt('0x03', 1);
    sinon
      .stub(connectedExplicitSigner, 'sendTransaction')
      .onFirstCall()
      .resolves(firstResponse)
      .onSecondCall()
      .resolves(secondResponse);
    sinon
      .stub(multiProvider, 'handleTx')
      .onFirstCall()
      .resolves(firstReceipt)
      .onSecondCall()
      .rejects(new Error('confirmation timeout'));

    const error = await captureSubmissionError(
      new EV5JsonRpcTxSubmitter(multiProvider, props, explicitSigner).submit(
        tx,
        tx,
      ),
    );

    expect(error.submittedTransactions).to.deep.equal([
      { transactionHash: firstResponse.hash, receipt: firstReceipt },
      { transactionHash: secondResponse.hash },
    ]);
  });

  it('retains a reverted receipt', async () => {
    const response = transactionResponse('0x05');
    const receipt = transactionReceipt('0x05', 0);
    sinon.stub(connectedExplicitSigner, 'sendTransaction').resolves(response);
    sinon.stub(multiProvider, 'handleTx').resolves(receipt);

    const error = await captureSubmissionError(
      new EV5JsonRpcTxSubmitter(multiProvider, props, explicitSigner).submit(
        tx,
      ),
    );

    expect(error.message).to.include(`Transaction ${response.hash} reverted`);
    expect(error.submittedTransactions).to.deep.equal([
      { transactionHash: response.hash, receipt },
    ]);
  });
});

async function captureSubmissionError(
  submission: Promise<unknown>,
): Promise<EV5JsonRpcSubmissionError> {
  try {
    await submission;
  } catch (error) {
    if (error instanceof EV5JsonRpcSubmissionError) return error;
    throw error;
  }
  throw new Error('Expected submission to fail');
}

function transactionResponse(hash: string): ContractTransaction {
  // CAST: minimal ethers response test double; only hash is read before handleTx.
  return { hash } as ContractTransaction;
}

function transactionReceipt(hash: string, status: number): ContractReceipt {
  // CAST: minimal ethers receipt test double; only hash/status are inspected.
  return { transactionHash: hash, status } as ContractReceipt;
}
