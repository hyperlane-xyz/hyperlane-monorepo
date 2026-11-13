import { expect } from 'chai';
import { constants, providers } from 'ethers';
import sinon from 'sinon';
import { TronJsonRpcProvider } from '@hyperlane-xyz/tron-sdk/runtime';
import { ProtocolType } from '@hyperlane-xyz/utils';
import { isReceiptFinalized } from './receiptFinality.js';

const txHash = `0x${'a'.repeat(64)}`;
const receipt: providers.TransactionReceipt = {
  to: constants.AddressZero,
  from: constants.AddressZero,
  contractAddress: constants.AddressZero,
  transactionIndex: 0,
  gasUsed: constants.Zero,
  logsBloom: '0x',
  blockHash: txHash,
  transactionHash: txHash,
  logs: [],
  blockNumber: 1,
  confirmations: 1,
  cumulativeGasUsed: constants.Zero,
  effectiveGasPrice: constants.Zero,
  byzantium: true,
  type: 0,
  status: 1,
};

describe('receipt finality', () => {
  afterEach(() => sinon.restore());

  it('requires the larger configured confirmation bound and defaults missing reorg policy to 32', async () => {
    const provider = sinon.createStubInstance(providers.StaticJsonRpcProvider);
    for (const blocks of [
      { reorgPeriod: 2, confirmations: 10 },
      { reorgPeriod: 10, confirmations: 2 },
      undefined,
    ]) {
      expect(
        await isReceiptFinalized(
          provider,
          { ...receipt, confirmations: 3 },
          blocks,
          ProtocolType.Ethereum,
        ),
      ).to.equal(false);
    }
    expect(
      await isReceiptFinalized(
        provider,
        { ...receipt, confirmations: 32 },
        undefined,
        ProtocolType.Ethereum,
      ),
    ).to.equal(true);
  });

  it('requires named finality and configured confirmation depth together', async () => {
    const provider = sinon.createStubInstance(providers.StaticJsonRpcProvider);
    provider.getBlock.callsFake(sinon.stub().resolves({ number: 1 }));
    const blocks = { reorgPeriod: 'finalized', confirmations: 10 } as const;
    expect(
      await isReceiptFinalized(
        provider,
        { ...receipt, confirmations: 9 },
        blocks,
        ProtocolType.Ethereum,
      ),
    ).to.equal(false);
    expect(
      await isReceiptFinalized(
        provider,
        { ...receipt, confirmations: 10 },
        blocks,
        ProtocolType.Ethereum,
      ),
    ).to.equal(true);
    expect(
      await isReceiptFinalized(
        provider,
        { ...receipt, confirmations: 10, blockNumber: 2 },
        blocks,
        ProtocolType.Ethereum,
      ),
    ).to.equal(false);
  });

  it('uses Tron solidification without depending on support for named JSON-RPC tags', async () => {
    const provider = sinon.createStubInstance(TronJsonRpcProvider);
    provider.getBlock.rejects(new Error('named tag unsupported'));
    provider.getFinalizedBlockNumber.resolves(0);
    const blocks = { reorgPeriod: 'finalized', confirmations: 2 } as const;
    expect(
      await isReceiptFinalized(
        provider,
        { ...receipt, confirmations: 2 },
        blocks,
        ProtocolType.Tron,
      ),
    ).to.equal(false);
    provider.getFinalizedBlockNumber.resolves(1);
    expect(
      await isReceiptFinalized(
        provider,
        { ...receipt, confirmations: 2 },
        blocks,
        ProtocolType.Tron,
      ),
    ).to.equal(true);
    expect(provider.getBlock.called).to.equal(false);
    provider.getFinalizedBlockNumber.rejects(
      new Error('solid head unavailable'),
    );
    let error: unknown;
    try {
      await isReceiptFinalized(
        provider,
        { ...receipt, confirmations: 2 },
        blocks,
        ProtocolType.Tron,
      );
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).to.include('solid head unavailable');
  });
});
