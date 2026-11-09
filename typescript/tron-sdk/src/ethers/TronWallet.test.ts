import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { mock } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { BigNumber, constants, utils, Wallet } from 'ethers';

import {
  assert,
  strip0x,
  TransactionSubmissionError,
} from '@hyperlane-xyz/utils';

import {
  TronTransaction,
  TronTransactionBuilder,
  TronWallet,
} from './TronWallet.js';

chai.use(chaiAsPromised);

const TXID = '42'.repeat(32);
const ADDRESS = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';
const BLOCK_HASH = 'ab'.repeat(32);
// Tron surfaces the deployed contract address as a `41`-prefixed hex string.
const DEPLOYED_TRON_HEX = '4119335987d77120c462ca7df51cf29f68a38e6d6c';
const DEPLOYED_EVM = '0x19335987d77120c462ca7dF51cf29f68A38E6D6C';

// Narrow shapes covering exactly the fields TronTransactionBuilder reads from
// each `trx` response, so the doubles below need no cast.
interface UnconfirmedTxLog {
  address: string;
  topics: string[];
  data?: string;
}
interface UnconfirmedTxInfo {
  id?: string;
  blockNumber?: number;
  contract_address?: string;
  receipt?: { result?: string; energy_usage_total?: number };
  log?: UnconfirmedTxLog[];
  contractResult?: string[];
}
interface CurrentBlockInfo {
  block_header: { raw_data: { number: number } };
}
interface BlockInfo {
  blockID: string;
}

type TrxDouble = {
  getUnconfirmedTransactionInfo: () => Promise<UnconfirmedTxInfo>;
  getCurrentBlock?: () => Promise<CurrentBlockInfo>;
  getBlockByNumber?: () => Promise<BlockInfo>;
};

function makeBuilder(
  confirmationTimeoutMs?: number,
  confirmationPollMs?: number,
): TronTransactionBuilder {
  return new TronTransactionBuilder(
    'https://node.example.com',
    ADDRESS,
    undefined,
    undefined,
    confirmationTimeoutMs,
    confirmationPollMs,
  );
}

function injectTrx(builder: TronTransactionBuilder, trx: TrxDouble): void {
  mock.method(builder.fullNode.instance, 'request', async (config: unknown) => {
    assert(
      typeof config === 'object' && config !== null && 'url' in config,
      'Expected receipt request config',
    );
    if (config.url === 'wallet/gettransactioninfobyid')
      return { data: await trx.getUnconfirmedTransactionInfo() };
    if (config.url === 'wallet/getnowblock' && trx.getCurrentBlock)
      return { data: await trx.getCurrentBlock() };
    if (config.url === 'wallet/getblockbynum' && trx.getBlockByNumber)
      return { data: await trx.getBlockByNumber() };
    throw new Error(`Unexpected receipt endpoint ${config.url}`);
  });
}

const blockByNumber = async (): Promise<BlockInfo> => ({ blockID: BLOCK_HASH });

// getTransactionResponse only reads `txID` off the Tron transaction; a full
// TronWeb transaction-union member is impractical to construct here.
function makeTronTx(txID: string): TronTransaction {
  // CAST: minimal stand-in for the TronTransaction union.
  return { txID } as unknown as TronTransaction;
}

function buildResponse(builder: TronTransactionBuilder) {
  return builder.getTransactionResponse(
    {
      chainId: 728126428,
      gasLimit: BigNumber.from(10),
      gasPrice: BigNumber.from(1),
      to: '0x496ba8ba0871a037ec1617f002f0a4afe5c2bae1',
    },
    makeTronTx(TXID),
  );
}

// A deployment response carries no `to`; the receipt's contractAddress must be
// derived from the Tron transaction info instead.
function buildDeploymentResponse(builder: TronTransactionBuilder) {
  return builder.getTransactionResponse(
    {
      chainId: 728126428,
      gasLimit: BigNumber.from(10),
      gasPrice: BigNumber.from(1),
      data: '0x60016002',
    },
    makeTronTx(TXID),
  );
}

describe('TronTransactionBuilder', () => {
  it('confirms transactions through the Tron HTTP API', async () => {
    const builder = makeBuilder();
    injectTrx(builder, {
      getUnconfirmedTransactionInfo: async () => ({
        id: TXID,
        blockNumber: 123,
        receipt: { result: 'SUCCESS', energy_usage_total: 7 },
        log: [
          {
            address: '496ba8ba0871a037ec1617f002f0a4afe5c2bae1',
            topics: ['8c5be1e5'],
            data: '01',
          },
          {
            address: '19335987d77120c462ca7df51cf29f68a38e6d6c',
            topics: ['788dbc1b'],
          },
        ],
      }),
      getBlockByNumber: blockByNumber,
    });

    const receipt = await buildResponse(builder).wait(1);

    expect(receipt.transactionHash).to.equal(`0x${TXID}`);
    expect(receipt.blockHash).to.equal(`0x${BLOCK_HASH}`);
    expect(receipt.status).to.equal(1);
    const [firstLog, secondLog] = receipt.logs;
    assert(firstLog && secondLog, 'Expected two receipt logs');
    expect(firstLog.address).to.equal(
      '0x496bA8BA0871A037eC1617f002F0A4AfE5C2bae1',
    );
    expect(secondLog.data).to.equal('0x');
  });

  it('returns once the requested confirmation depth is reached', async () => {
    // Short timeout so a broken actualConfirmations computation fails fast
    // instead of polling until the caller's (here unbounded) production wait.
    const builder = makeBuilder(200, 5);
    injectTrx(builder, {
      getUnconfirmedTransactionInfo: async () => ({
        id: TXID,
        blockNumber: 100,
        receipt: { result: 'SUCCESS', energy_usage_total: 7 },
        log: [],
      }),
      getCurrentBlock: async () => ({
        block_header: { raw_data: { number: 101 } },
      }),
      getBlockByNumber: blockByNumber,
    });

    const receipt = await buildResponse(builder).wait(2);

    // actualConfirmations = currentBlock(101) - txBlock(100) + 1 = 2.
    // Without the `+ 1` this would be 1 (< 2) and the poll would time out.
    expect(receipt.confirmations).to.equal(2);
    expect(receipt.blockNumber).to.equal(100);
  });

  it('wait(0) returns null without blocking for a still-pending tx', async () => {
    // Unbounded builder: proves the wait(0) probe returns immediately rather
    // than entering (and hanging in) the confirmation poll loop.
    const builder = makeBuilder();
    let lookups = 0;
    injectTrx(builder, {
      getUnconfirmedTransactionInfo: async () => {
        lookups += 1;
        return {};
      },
    });

    const receipt = await buildResponse(builder).wait(0);

    expect(receipt).to.equal(null);
    expect(lookups).to.equal(1);
  });

  it('wait(0) returns the receipt for an already-mined tx', async () => {
    const builder = makeBuilder();
    injectTrx(builder, {
      getUnconfirmedTransactionInfo: async () => ({
        id: TXID,
        blockNumber: 123,
        receipt: { result: 'SUCCESS', energy_usage_total: 7 },
        log: [],
      }),
      getBlockByNumber: blockByNumber,
    });

    const receipt = await buildResponse(builder).wait(0);

    expect(receipt).to.not.equal(null);
    expect(receipt?.blockNumber).to.equal(123);
    expect(receipt?.blockHash).to.equal(`0x${BLOCK_HASH}`);
    expect(receipt?.confirmations).to.equal(1);
  });

  it('wait(0) rejects with the revert reason for a mined-but-reverted tx', async () => {
    const builder = makeBuilder();
    const revertReason = 'insufficient allowance';
    const encodedRevert =
      '08c379a0' +
      strip0x(utils.defaultAbiCoder.encode(['string'], [revertReason]));
    injectTrx(builder, {
      getUnconfirmedTransactionInfo: async () => ({
        id: TXID,
        blockNumber: 123,
        receipt: { result: 'REVERT' },
        contractResult: [encodedRevert],
      }),
    });

    // Mined-but-reverted must surface as a failure even on the wait(0) probe,
    // matching ethers' status-0 CALL_EXCEPTION rather than a status-1 receipt.
    await expect(buildResponse(builder).wait(0)).to.be.rejectedWith(
      new RegExp(
        `Tron Transaction Failed: ${revertReason} \\(txid: ${TXID}\\)`,
      ),
    );
  });

  it('does not finalize a failed receipt before the requested depth', async () => {
    const builder = makeBuilder(200, 5);
    const revertReason = 'insufficient allowance';
    const encodedRevert =
      '08c379a0' +
      strip0x(utils.defaultAbiCoder.encode(['string'], [revertReason]));
    let blockChecks = 0;
    injectTrx(builder, {
      getUnconfirmedTransactionInfo: async () => ({
        id: TXID,
        blockNumber: 100,
        receipt: { result: 'REVERT' },
        contractResult: [encodedRevert],
      }),
      // First poll yields depth 1 (< 2) so the failure must NOT be finalized;
      // the second poll reaches depth 2 and only then may reject.
      getCurrentBlock: async () => {
        blockChecks += 1;
        const number = blockChecks < 2 ? 100 : 101;
        return {
          block_header: { raw_data: { number } },
        };
      },
    });

    await expect(buildResponse(builder).wait(2)).to.be.rejectedWith(
      new RegExp(
        `Tron Transaction Failed: ${revertReason} \\(txid: ${TXID}\\)`,
      ),
    );
    // Proves the reorgable failure was not finalized at the first confirmation.
    expect(blockChecks).to.be.greaterThan(1);
  });

  it('populates the deployed contract address and block hash for a deployment', async () => {
    const builder = makeBuilder();
    injectTrx(builder, {
      getUnconfirmedTransactionInfo: async () => ({
        id: TXID,
        blockNumber: 123,
        contract_address: DEPLOYED_TRON_HEX,
        receipt: { result: 'SUCCESS', energy_usage_total: 7 },
        log: [],
      }),
      getBlockByNumber: blockByNumber,
    });

    const receipt = await buildDeploymentResponse(builder).wait(1);

    expect(receipt.contractAddress).to.equal(DEPLOYED_EVM);
    expect(receipt.contractAddress).to.not.equal(constants.AddressZero);
    expect(receipt.blockHash).to.equal(`0x${BLOCK_HASH}`);
  });

  it('rejects with the revert reason when the receipt reports a failure', async () => {
    const builder = makeBuilder();
    const revertReason = 'insufficient allowance';
    const encodedRevert =
      '08c379a0' +
      strip0x(utils.defaultAbiCoder.encode(['string'], [revertReason]));
    injectTrx(builder, {
      getUnconfirmedTransactionInfo: async () => ({
        id: TXID,
        blockNumber: 123,
        receipt: { result: 'REVERT' },
        contractResult: [encodedRevert],
      }),
    });

    await expect(buildResponse(builder).wait(1)).to.be.rejectedWith(
      new RegExp(
        `Tron Transaction Failed: ${revertReason} \\(txid: ${TXID}\\)`,
      ),
    );
  });

  it('bounds a single wait without changing the builder default', async () => {
    const builder = makeBuilder(undefined, 5);
    let confirmed = false;
    injectTrx(builder, {
      getUnconfirmedTransactionInfo: async () =>
        confirmed
          ? { id: TXID, blockNumber: 123, receipt: { result: 'SUCCESS' } }
          : {},
      getBlockByNumber: blockByNumber,
    });
    const response = buildResponse(builder);
    await expect(response.wait(1, 15)).to.be.rejectedWith(
      'not confirmed within 15ms',
    );
    confirmed = true;
    expect((await response.wait(1)).status).to.equal(1);
  });

  it('rejects with the txid once the confirmation timeout elapses', async () => {
    const timeoutMs = 40;
    const builder = makeBuilder(timeoutMs, 5);
    injectTrx(builder, {
      // Never surfaces an `id`, so the poll never confirms and must time out.
      getUnconfirmedTransactionInfo: async () => ({}),
    });

    await expect(buildResponse(builder).wait(1)).to.be.rejectedWith(
      new RegExp(
        `Tron transaction ${TXID} not confirmed within ${timeoutMs}ms`,
      ),
    );
  });
});

describe('TronWallet submission boundary', () => {
  function makeWallet(failAt: 'sign' | 'broadcast') {
    const wallet = new TronWallet(
      Wallet.createRandom().privateKey,
      'https://node.example.com',
    );
    const order: string[] = [];
    const tx = makeTronTx(TXID);
    wallet.populateTransaction = async () => ({
      gasLimit: BigNumber.from(10),
      gasPrice: BigNumber.from(1),
    });
    // Replace only network/signing dependencies; exercise the actual wallet send method.
    const internals = wallet as unknown as {
      txBuilder: { buildTransaction: () => Promise<TronTransaction> };
      makeUnique: (transaction: TronTransaction) => Promise<TronTransaction>;
      tronWeb: {
        trx: {
          sign: () => Promise<TronTransaction>;
          sendRawTransaction: () => Promise<never>;
        };
      };
    };
    internals.txBuilder = { buildTransaction: async () => tx };
    internals.makeUnique = async (transaction) => transaction;
    internals.tronWeb = {
      trx: {
        sign: async () => {
          order.push('sign');
          if (failAt === 'sign') throw new Error('sign failed');
          return tx;
        },
        sendRawTransaction: async () => {
          order.push('broadcast');
          throw new Error('response lost');
        },
      },
    };
    return { wallet, order };
  }

  it('retains the locally computed txID when the broadcast response is lost', async () => {
    const { wallet, order } = makeWallet('broadcast');
    let observedHash: string | undefined;
    let caught: unknown;
    try {
      await wallet.sendTransaction(
        {},
        {
          onSubmissionAttempt: (hash) => {
            observedHash = hash;
            order.push('attempt');
          },
          onSubmitted: (hash) => {
            order.push('identity');
            observedHash = hash;
          },
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(TransactionSubmissionError);
    expect(caught).to.include({
      submissionState: 'unknown',
      txHash: `0x${TXID}`,
    });
    expect(observedHash).to.equal(`0x${TXID}`);
    expect(order).to.deep.equal(['sign', 'attempt', 'broadcast']);
  });

  it('proves a signing failure occurred before broadcast', async () => {
    const { wallet, order } = makeWallet('sign');
    let caught: unknown;
    try {
      await wallet.sendTransaction({}, {});
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(TransactionSubmissionError);
    expect(caught).to.include({ submissionState: 'not_submitted' });
    expect(order).to.deep.equal(['sign']);
  });
});

describe('Tron receipt deadlines', () => {
  afterEach(() => mock.restoreAll());

  function requestSignal(config: unknown): AbortSignal {
    assert(
      typeof config === 'object' &&
        config !== null &&
        'signal' in config &&
        config.signal instanceof AbortSignal,
      'Expected per-wait abort signal',
    );
    return config.signal;
  }

  it('ends a wait even when the transport ignores abort and never starts another request', async () => {
    const builder = makeBuilder();
    let signal: AbortSignal | undefined;
    let requests = 0;
    mock.method(builder.fullNode.instance, 'request', (config: unknown) => {
      requests++;
      signal = requestSignal(config);
      return new Promise(() => {});
    });
    const started = Date.now();
    const error: unknown = await buildResponse(builder)
      .wait(1, 20)
      .catch((error: unknown) => error);
    assert(error instanceof Error && 'code' in error, 'Expected typed timeout');
    expect(error.code).to.equal('TIMEOUT');
    expect(error.message).to.include(TXID);
    expect(Date.now() - started).to.be.lessThan(500);
    expect(signal?.aborted).to.equal(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(requests).to.equal(1);
  });

  it('stops retry backoff at the deadline', async () => {
    const builder = makeBuilder();
    let requests = 0;
    mock.method(builder.fullNode.instance, 'request', async () => {
      requests++;
      throw new Error('RPC unavailable');
    });
    await expect(buildResponse(builder).wait(1, 20)).to.be.rejectedWith(
      'not confirmed within 20ms',
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(requests).to.equal(1);
  });

  it('includes receipt block lookup in the same deadline', async () => {
    const builder = makeBuilder();
    let requests = 0;
    let blockSignal: AbortSignal | undefined;
    mock.method(
      builder.fullNode.instance,
      'request',
      async (config: unknown) => {
        requests++;
        if (requests === 1)
          return {
            data: {
              id: TXID,
              blockNumber: 123,
              receipt: { result: 'SUCCESS' },
            },
          };
        blockSignal = requestSignal(config);
        return new Promise(() => {});
      },
    );
    await expect(buildResponse(builder).wait(1, 20)).to.be.rejectedWith(
      'not confirmed within 20ms',
    );
    expect(requests).to.equal(2);
    expect(blockSignal?.aborted).to.equal(true);
  });

  it('keeps simultaneous waits independent', async () => {
    const builder = makeBuilder();
    let requests = 0;
    let longSignal: AbortSignal | undefined;
    mock.method(
      builder.fullNode.instance,
      'request',
      async (config: unknown) => {
        requests++;
        if (requests === 1) return new Promise(() => {});
        if (requests === 2) {
          longSignal = requestSignal(config);
          await new Promise((resolve) => setTimeout(resolve, 40));
          return {
            data: {
              id: TXID,
              blockNumber: 123,
              receipt: { result: 'SUCCESS' },
            },
          };
        }
        return { data: { blockID: BLOCK_HASH } };
      },
    );
    const response = buildResponse(builder);
    const short = expect(response.wait(1, 10)).to.be.rejectedWith(
      'not confirmed within 10ms',
    );
    const long = response.wait(1, 500);
    await short;
    expect(longSignal?.aborted).to.equal(false);
    expect((await long).transactionHash).to.equal(`0x${TXID}`);
  });

  it('cancels the actual Axios request while preserving custom RPC headers', async () => {
    let header: string | string[] | undefined;
    let closed = false;
    const server = createServer((request, response) => {
      header = request.headers['x-receipt-test'];
      response.on('close', () => {
        closed = true;
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(
      address && typeof address === 'object',
      'Expected listening test server',
    );
    const builder = new TronTransactionBuilder(
      `http://127.0.0.1:${address.port}`,
      ADDRESS,
      undefined,
      { 'x-receipt-test': 'preserved' },
    );
    const originalTimeout = builder.fullNode.timeout;
    try {
      await expect(buildResponse(builder).wait(1, 100)).to.be.rejectedWith(
        'not confirmed within 100ms',
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(header).to.equal('preserved');
      expect(closed).to.equal(true);
      expect(builder.fullNode.timeout).to.equal(originalTimeout);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
