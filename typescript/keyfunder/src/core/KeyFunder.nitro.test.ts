import { expect } from 'chai';
import { BigNumber, ethers } from 'ethers';
import { pino } from 'pino';
import sinon from 'sinon';

import { ChainTechnicalStack, MultiProvider } from '@hyperlane-xyz/sdk';

import { KeyFunder } from './KeyFunder.js';

describe('KeyFunder Nitro transfers', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('tolerates parent-chain gas costs increasing after estimation', async () => {
    const recipient = `0x${'12'.repeat(20)}`;
    const funder = `0x${'34'.repeat(20)}`;
    const provider = sinon.createStubInstance(ethers.providers.JsonRpcProvider);
    provider.getBalance.resolves(BigNumber.from(0));
    const signer = sinon.createStubInstance(ethers.Wallet);
    signer.getAddress.resolves(funder);
    signer.getBalance.resolves(ethers.utils.parseEther('5'));
    const multiProvider = sinon.createStubInstance(MultiProvider);
    multiProvider.getProvider.returns(provider);
    multiProvider.getSigner.returns(signer);
    multiProvider.getChainMetadata.returns({
      technicalStack: ChainTechnicalStack.ArbitrumNitro,
      nativeToken: { name: 'Hyperliquid', symbol: 'HYPE', decimals: 18 },
    });
    // The failed Elysium transfer was estimated at 21,217 gas; the parent
    // data fee can increase before the next transaction is submitted.
    const estimateGas = sinon.stub<
      Parameters<MultiProvider['estimateGas']>,
      ReturnType<MultiProvider['estimateGas']>
    >();
    estimateGas.resolves(BigNumber.from(21_217));
    multiProvider.estimateGas = estimateGas;
    const sendTransaction = sinon.stub<
      Parameters<MultiProvider['sendTransaction']>,
      ReturnType<MultiProvider['sendTransaction']>
    >();
    multiProvider.sendTransaction = sendTransaction;
    sendTransaction.callsFake(async (_chain, transaction) => {
      const tx = await transaction;
      const gasLimit = tx.gasLimit;
      if (!gasLimit || BigNumber.from(gasLimit).lt(22_000)) {
        throw new Error('intrinsic gas too low');
      }
      expect(tx.to).to.equal(recipient);
      expect(tx.value?.toString()).to.equal(
        ethers.utils.parseEther('0.059').toString(),
      );
      return {
        to: recipient,
        from: funder,
        contractAddress: ethers.constants.AddressZero,
        transactionIndex: 0,
        gasUsed: BigNumber.from(22_000),
        logsBloom: '0x',
        blockHash: ethers.constants.HashZero,
        transactionHash: ethers.constants.HashZero,
        logs: [],
        blockNumber: 1,
        confirmations: 1,
        cumulativeGasUsed: BigNumber.from(22_000),
        effectiveGasPrice: BigNumber.from(100_000_000),
        byzantium: true,
        type: 2,
      };
    });

    const keyFunder = new KeyFunder(
      multiProvider,
      {
        version: '1',
        roles: { relayer: { address: recipient } },
        chains: { elysium: { balances: { relayer: '0.059' } } },
      },
      { logger: pino({ level: 'silent' }) },
    );

    await keyFunder.fundChain('elysium');

    sinon.assert.calledOnceWithExactly(estimateGas, 'elysium', {
      to: recipient,
      value: ethers.utils.parseEther('0.059'),
    });
    sinon.assert.calledOnce(sendTransaction);
  });
});
