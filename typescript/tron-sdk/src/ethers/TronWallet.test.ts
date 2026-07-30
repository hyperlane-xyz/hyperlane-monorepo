import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { BigNumber, utils } from 'ethers';
import { TronWeb } from 'tronweb';

import { strip0x } from '@hyperlane-xyz/utils';

import { TronTransaction, TronTransactionBuilder } from './TronWallet.js';

chai.use(chaiAsPromised);

const TXID = '42'.repeat(32);
const ADDRESS = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';

type UnconfirmedInfo = Awaited<
  ReturnType<TronWeb['trx']['getUnconfirmedTransactionInfo']>
>;
type CurrentBlock = Awaited<ReturnType<TronWeb['trx']['getCurrentBlock']>>;

type TrxDouble = {
  getUnconfirmedTransactionInfo: TronWeb['trx']['getUnconfirmedTransactionInfo'];
  getCurrentBlock?: TronWeb['trx']['getCurrentBlock'];
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
  (builder as unknown as { trx: TrxDouble }).trx = trx;
}

function buildResponse(builder: TronTransactionBuilder) {
  return builder.getTransactionResponse(
    {
      chainId: 728126428,
      gasLimit: BigNumber.from(10),
      gasPrice: BigNumber.from(1),
      to: '0x496ba8ba0871a037ec1617f002f0a4afe5c2bae1',
    },
    { txID: TXID } as unknown as TronTransaction,
  );
}

describe('TronTransactionBuilder', () => {
  it('confirms transactions through the Tron HTTP API', async () => {
    const builder = makeBuilder();
    injectTrx(builder, {
      getUnconfirmedTransactionInfo: async () =>
        ({
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
        }) as unknown as UnconfirmedInfo,
    });

    const receipt = await buildResponse(builder).wait(1);

    expect(receipt.transactionHash).to.equal(`0x${TXID}`);
    expect(receipt.blockHash).to.equal(`0x${'0'.repeat(64)}`);
    expect(receipt.status).to.equal(1);
    expect(receipt.logs[0].address).to.equal(
      '0x496bA8BA0871A037eC1617f002F0A4AfE5C2bae1',
    );
    expect(receipt.logs[1].data).to.equal('0x');
  });

  it('returns once the requested confirmation depth is reached', async () => {
    // Short timeout so a broken actualConfirmations computation fails fast
    // instead of polling until the production timeout.
    const builder = makeBuilder(200, 5);
    injectTrx(builder, {
      getUnconfirmedTransactionInfo: async () =>
        ({
          id: TXID,
          blockNumber: 100,
          receipt: { result: 'SUCCESS', energy_usage_total: 7 },
          log: [],
        }) as unknown as UnconfirmedInfo,
      getCurrentBlock: async () =>
        ({
          block_header: { raw_data: { number: 101 } },
        }) as unknown as CurrentBlock,
    });

    const receipt = await buildResponse(builder).wait(2);

    // actualConfirmations = currentBlock(101) - txBlock(100) + 1 = 2.
    // Without the `+ 1` this would be 1 (< 2) and the poll would time out.
    expect(receipt.confirmations).to.equal(2);
    expect(receipt.blockNumber).to.equal(100);
  });

  it('rejects with the revert reason when the receipt reports a failure', async () => {
    const builder = makeBuilder();
    const revertReason = 'insufficient allowance';
    const encodedRevert =
      '08c379a0' +
      strip0x(utils.defaultAbiCoder.encode(['string'], [revertReason]));
    injectTrx(builder, {
      getUnconfirmedTransactionInfo: async () =>
        ({
          id: TXID,
          blockNumber: 123,
          receipt: { result: 'REVERT' },
          contractResult: [encodedRevert],
        }) as unknown as UnconfirmedInfo,
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
      getUnconfirmedTransactionInfo: async () =>
        ({}) as unknown as UnconfirmedInfo,
    });

    await expect(buildResponse(builder).wait(1)).to.be.rejectedWith(
      new RegExp(
        `Tron transaction ${TXID} not confirmed within ${timeoutMs}ms`,
      ),
    );
  });
});
