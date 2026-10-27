import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { expect } from 'chai';
import { ethers } from 'ethers';
import { custom } from 'viem';
import type { RouteExtended } from '@lifi/sdk';

import { TransactionSubmissionError, assert } from '@hyperlane-xyz/utils';

import { Erc20ApprovalError } from './erc20Approve.js';
import { LiFiSubmission } from './lifiSubmission.js';

const token = '0x1111111111111111111111111111111111111111';
const spender = '0x2222222222222222222222222222222222222222';
const wallet = ethers.Wallet.createRandom();
const approvalAbi = new ethers.utils.Interface([
  'function approve(address spender, uint256 amount)',
]);
const signed = (overrides: ethers.providers.TransactionRequest = {}) =>
  wallet.signTransaction({
    chainId: 1,
    nonce: 0,
    gasLimit: 100000,
    gasPrice: 1,
    to: spender,
    data: '0x12345678',
    ...overrides,
  });

describe('LiFi submission boundaries', () => {
  it('sequences reset, exact approval and source only after matching approval completion', async () => {
    const submission = new LiFiSubmission();
    let sends = 0;
    const transport = submission.evmTransport(
      custom({
        request: async ({ params }) => {
          sends++;
          return ethers.utils.keccak256(params[0]);
        },
      }),
      1,
      token,
      spender,
      100n,
    )({});
    for (const [nonce, amount] of [
      [0, 0],
      [1, 100],
    ]) {
      const raw = await signed({
        nonce,
        to: token,
        data: approvalAbi.encodeFunctionData('approve', [spender, amount]),
      });
      await submission.run(() =>
        transport.request({ method: 'eth_sendRawTransaction', params: [raw] }),
      );
      // This SDK event follows its receipt waiter, including reset-to-zero.
      submission.observeRoute({
        fromChainId: 1,
        steps: [
          {
            execution: {
              process: [
                {
                  type: 'TOKEN_ALLOWANCE',
                  status: 'DONE',
                  chainId: 1,
                  txHash: ethers.utils.keccak256(raw),
                },
              ],
            },
          },
        ],
      } as RouteExtended);
    }
    const raw = await signed({ nonce: 2 });
    await submission.run(() =>
      transport.request({ method: 'eth_sendRawTransaction', params: [raw] }),
    );
    expect(sends).to.equal(3);
    expect(submission.txHash).to.equal(ethers.utils.keccak256(raw));
  });

  it('preserves the signed source identity when the broadcast response is lost', async () => {
    const raw = await signed();
    const hash = ethers.utils.keccak256(raw);
    let observed: string | undefined;
    const submission = new LiFiSubmission({
      onSubmissionAttempt: (id) => {
        observed = id;
      },
    });
    const transport = submission.evmTransport(
      custom(
        {
          request: async () => {
            expect(observed).to.equal(hash);
            throw new Error('lost response');
          },
        },
        { retryCount: 0 },
      ),
      1,
      token,
      spender,
      100n,
    )({});
    const error = await submission
      .run(() =>
        transport.request({
          method: 'eth_sendRawTransaction',
          params: [raw],
        }),
      )
      .catch((error) => error);
    expect(error).to.be.instanceOf(TransactionSubmissionError);
    assert(
      error instanceof TransactionSubmissionError,
      'Expected submission error',
    );
    expect(error.submissionState).to.equal('unknown');
    assert(
      error instanceof TransactionSubmissionError,
      'Expected submission error',
    );
    expect(error.txHash).to.equal(hash);
  });

  it('retains the acknowledged source after a later SDK confirmation error', async () => {
    const raw = await signed();
    const hash = ethers.utils.keccak256(raw);
    let observed: string | undefined;
    const submission = new LiFiSubmission({
      onSubmitted: (id) => {
        observed = id;
      },
    });
    const transport = submission.evmTransport(
      custom({ request: async () => hash }),
      1,
      token,
      spender,
      100n,
    )({});
    const error = await submission
      .run(async () => {
        await transport.request({
          method: 'eth_sendRawTransaction',
          params: [raw],
        });
        expect(observed).to.equal(hash);
        throw new Error('receipt provider unavailable');
      })
      .catch((error) => error);
    assert(
      error instanceof TransactionSubmissionError,
      'Expected submission error',
    );
    expect(error.submissionState).to.equal('submitted');
    assert(
      error instanceof TransactionSubmissionError,
      'Expected submission error',
    );
    expect(error.txHash).to.equal(hash);
  });

  it('tracks an approval separately when the SDK hides its broadcast error', async () => {
    const raw = await signed({
      to: token,
      data: approvalAbi.encodeFunctionData('approve', [spender, 100]),
    });
    const submission = new LiFiSubmission();
    const transport = submission.evmTransport(
      custom(
        {
          request: async () => {
            throw new Error('lost approval response');
          },
        },
        { retryCount: 0 },
      ),
      1,
      token,
      spender,
      100n,
    )({});
    const error = await submission
      .run(() =>
        transport.request({ method: 'eth_sendRawTransaction', params: [raw] }),
      )
      .catch((error) => error);
    expect(error).to.be.instanceOf(Erc20ApprovalError);
    assert(
      error instanceof TransactionSubmissionError,
      'Expected submission error',
    );
    expect(error.txHash).to.equal(ethers.utils.keccak256(raw));
    expect(submission.txHash).to.equal(undefined);
  });

  it('rejects an excessive approval and chain change before the RPC', async () => {
    let sends = 0;
    const submission = new LiFiSubmission();
    const transport = submission.evmTransport(
      custom({
        request: async () => {
          sends++;
        },
      }),
      1,
      token,
      spender,
      100n,
    )({});
    for (const raw of [
      await signed({
        to: token,
        data: approvalAbi.encodeFunctionData('approve', [spender, 101]),
      }),
      await signed({ chainId: 2 }),
    ]) {
      const error = await submission
        .run(() =>
          transport.request({
            method: 'eth_sendRawTransaction',
            params: [raw],
          }),
        )
        .catch((error) => error);
      assert(
        error instanceof TransactionSubmissionError,
        'Expected submission error',
      );
      expect(error.submissionState).to.equal('not_submitted');
    }
    expect(sends).to.equal(0);
  });

  it('refuses a new source identity after an exposed transaction', async () => {
    let sends = 0;
    const submission = new LiFiSubmission();
    const transport = submission.evmTransport(
      custom({
        request: async ({ params }) => {
          sends++;
          return ethers.utils.keccak256(params[0]);
        },
      }),
      1,
      token,
      spender,
      100n,
    )({});
    const first = await signed();
    await submission.run(() =>
      transport.request({ method: 'eth_sendRawTransaction', params: [first] }),
    );
    const next = await signed({ nonce: 1 });
    const error = await submission
      .run(() =>
        transport.request({ method: 'eth_sendRawTransaction', params: [next] }),
      )
      .catch((error) => error);
    assert(
      error instanceof TransactionSubmissionError,
      'Expected submission error',
    );
    expect(error.txHash).to.equal(ethers.utils.keccak256(first));
    assert(
      error instanceof TransactionSubmissionError,
      'Expected submission error',
    );
    expect(error.submissionState).to.equal('submitted');
    expect(sends).to.equal(1);
  });

  it('retains the Solana signature handed to the SDK before its RPC fails', async () => {
    const payer = Keypair.generate();
    const submission = new LiFiSubmission();
    const adapter = submission.solanaWallet(bs58.encode(payer.secretKey));
    const transaction = new Transaction({
      feePayer: payer.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
    }).add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    );
    let hash: string | undefined;
    const error = await submission
      .run(async () => {
        const [signed] = await adapter.signAllTransactions([transaction]);
        hash = bs58.encode(signed.signature!);
        throw new Error('SDK confirmation timeout');
      })
      .catch((error) => error);
    assert(
      error instanceof TransactionSubmissionError,
      'Expected submission error',
    );
    expect(error.submissionState).to.equal('unknown');
    assert(
      error instanceof TransactionSubmissionError,
      'Expected submission error',
    );
    expect(error.txHash).to.equal(hash);
    expect(hash).to.be.a('string');
  });

  it('rejects a Solana bundle before signing any member', async () => {
    const payer = Keypair.generate();
    const submission = new LiFiSubmission();
    const adapter = submission.solanaWallet(bs58.encode(payer.secretKey));
    const error = await submission
      .run(() =>
        adapter.signAllTransactions([new Transaction(), new Transaction()]),
      )
      .catch((error) => error);
    assert(
      error instanceof TransactionSubmissionError,
      'Expected submission error',
    );
    expect(error.submissionState).to.equal('not_submitted');
    expect(submission.txHash).to.equal(undefined);
  });
});
