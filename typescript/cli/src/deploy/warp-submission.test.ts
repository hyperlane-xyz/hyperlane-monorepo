import { expect } from 'chai';
import { Wallet } from 'ethers';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sinon from 'sinon';

import { AltVMJsonRpcSubmissionError } from '@hyperlane-xyz/provider-sdk';
import { PartialRegistry } from '@hyperlane-xyz/registry';
import {
  EV5JsonRpcSubmissionError,
  MultiProvider,
  MultiProtocolProvider,
  TxSubmitterBuilder,
  testChainMetadata,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { runSubmit } from '../config/submit.js';
import type { WriteCommandContext } from '../context/types.js';
import { readYamlOrJson } from '../utils/files.js';

import { submitChainTransactions } from './warp.js';

describe('warp submission irreversible progress', () => {
  let sandbox: sinon.SinonSandbox;
  let directory: string;
  let context: WriteCommandContext;
  const tx = {
    chainId: 9913371,
    to: '0x1111111111111111111111111111111111111111',
    data: '0x',
  };

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    directory = mkdtempSync(join(tmpdir(), 'warp-submission-'));
    context = {
      multiProvider: MultiProvider.createTestMultiProvider(),
      multiProtocolProvider: new MultiProtocolProvider(testChainMetadata),
      chainMetadata: testChainMetadata,
      registry: new PartialRegistry({}),
      signer: Wallet.createRandom(),
      key: {},
      skipConfirmation: true,
      supportedProtocols: [ProtocolType.Ethereum],
      altVmSigners: {},
      altVmProviders: {},
    };
  });

  afterEach(() => {
    sandbox.restore();
    rmSync(directory, { recursive: true, force: true });
  });

  function parameters() {
    return {
      context,
      warpCoreConfig: { tokens: [] },
      warpDeployConfig: {},
      receiptsDir: directory,
    };
  }

  it('does not replay the main submission when ownership submission fails', async () => {
    const submit = sandbox.stub(TxSubmitterBuilder.prototype, 'submit');
    submit.onFirstCall().resolves([]);
    submit
      .onSecondCall()
      .rejects(new Error('Ownership confirmation unavailable'));
    const [outcome] = await Promise.allSettled([
      submitChainTransactions(parameters(), 'test1', [tx], [], [tx], false),
    ]);
    expect(outcome.status).to.equal('rejected');
    expect(submit.callCount).to.equal(2);
  });

  it('does not rebroadcast after receipt persistence fails', async () => {
    const submit = sandbox
      .stub(TxSubmitterBuilder.prototype, 'submit')
      .resolves([]);
    const file = join(directory, 'file');
    writeFileSync(file, 'not a directory');
    const [outcome] = await Promise.allSettled([
      submitChainTransactions(
        { ...parameters(), receiptsDir: file },
        'test1',
        [tx],
        [],
        [],
        false,
      ),
    ]);
    expect(outcome.status).to.equal('rejected');
    expect(submit.calledOnce).to.be.true;
  });

  it('persists AltVM partial progress and never replays the failed batch', async () => {
    const failure = new AltVMJsonRpcSubmissionError(
      'Confirmation failed',
      [{ transactionHash: 'confirmed' }],
      [tx, tx],
      new Error('unknown outcome'),
    );
    const submit = sandbox
      .stub(TxSubmitterBuilder.prototype, 'submit')
      .rejects(failure);
    const [outcome] = await Promise.allSettled([
      submitChainTransactions(parameters(), 'test1', [tx, tx], [], [], false),
    ]);
    expect(outcome.status).to.equal('rejected');
    if (outcome.status === 'rejected') expect(outcome.reason).to.equal(failure);
    expect(submit.calledOnce).to.be.true;
    const files = readdirSync(directory);
    expect(files).to.have.length(1);
    expect(files[0]).to.include('main-partial');
    expect(readYamlOrJson(join(directory, files[0]))).to.deep.equal({
      confirmedReceipts: failure.confirmedReceipts,
      attemptedTransactions: failure.attemptedTransactions,
    });
  });

  it('retains retry for setup failures before the first submission', async () => {
    const addresses = sandbox.stub(context.registry, 'getAddresses');
    addresses
      .onFirstCall()
      .throws(new Error('Registry temporarily unavailable'));
    addresses.returns({});
    const submit = sandbox
      .stub(TxSubmitterBuilder.prototype, 'submit')
      .resolves([]);
    await submitChainTransactions(parameters(), 'test1', [tx], [], [], false);
    expect(addresses.calledTwice).to.be.true;
    expect(submit.calledOnce).to.be.true;
  });

  it('preserves and writes EVM progress through the generic submit command', async () => {
    const failure = new EV5JsonRpcSubmissionError(
      'Confirmation failed',
      [{ transactionHash: '0x01' }],
      new Error('unknown outcome'),
    );
    sandbox.stub(TxSubmitterBuilder.prototype, 'submit').rejects(failure);
    const [outcome] = await Promise.allSettled([
      runSubmit({
        context,
        chain: 'test1',
        transactions: [tx],
        receiptsFilepath: directory,
      }),
    ]);
    if (outcome.status !== 'rejected')
      throw new Error('Expected submission failure');
    expect(outcome.reason).to.equal(failure);
    const files = readdirSync(directory);
    expect(files).to.have.length(1);
    expect(files[0]).to.include('partial');
    expect(readYamlOrJson(join(directory, files[0]))).to.deep.equal(
      failure.submittedTransactions,
    );
  });
  it('retains progress together with an error writing generic-submit evidence', async () => {
    const failure = new EV5JsonRpcSubmissionError(
      'Confirmation failed',
      [{ transactionHash: '0x01' }],
      new Error('unknown outcome'),
    );
    sandbox.stub(TxSubmitterBuilder.prototype, 'submit').rejects(failure);
    const file = join(directory, 'file');
    writeFileSync(file, 'not a directory');
    const [outcome] = await Promise.allSettled([
      runSubmit({
        context,
        chain: 'test1',
        transactions: [tx],
        receiptsFilepath: file,
      }),
    ]);
    if (outcome.status !== 'rejected')
      throw new Error('Expected submission failure');
    const error: unknown = outcome.reason;
    if (!(error instanceof AggregateError))
      throw new Error('Missing combined error');
    expect(error.errors[0]).to.equal(failure);
    expect(error.errors).to.have.length(2);
  });
});
