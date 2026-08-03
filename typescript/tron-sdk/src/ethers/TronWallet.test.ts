import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { BigNumber, constants, utils } from 'ethers';

import { strip0x } from '@hyperlane-xyz/utils';

import { TronTransaction, TronTransactionBuilder } from './TronWallet.js';

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
  // CAST: overwrite the builder's private `trx` field with a minimal double.
  (builder as unknown as { trx: TrxDouble }).trx = trx;
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
    expect(receipt.logs[0].address).to.equal(
      '0x496bA8BA0871A037eC1617f002F0A4AfE5C2bae1',
    );
    expect(receipt.logs[1].data).to.equal('0x');
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
