import { expect } from 'chai';
import { BigNumber, ethers } from 'ethers';
import type { PopulatedTransaction } from 'ethers';
import { pino } from 'pino';
import sinon from 'sinon';

import { ChainTechnicalStack, MultiProvider } from '@hyperlane-xyz/sdk';

import { KeyFunderMetrics } from '../metrics/Metrics.js';

import { KeyFunder } from './KeyFunder.js';

const recipient = `0x${'12'.repeat(20)}`;
const funder = `0x${'34'.repeat(20)}`;

function setup(
  balance = ethers.utils.parseEther('5'),
  fees: Pick<
    PopulatedTransaction,
    'gasPrice' | 'maxFeePerGas' | 'maxPriorityFeePerGas'
  > = { gasPrice: BigNumber.from(100_000_000) },
) {
  const provider = sinon.createStubInstance(ethers.providers.JsonRpcProvider);
  provider.getBalance.resolves(BigNumber.from(0));
  const signer = sinon.createStubInstance(ethers.Wallet);
  signer.getAddress.resolves(funder);
  signer.getBalance.resolves(balance);
  signer.populateTransaction.resolves({
    to: recipient,
    from: funder,
    gasLimit: BigNumber.from(23_338),
    ...fees,
  });
  const multiProvider = sinon.createStubInstance(MultiProvider);
  multiProvider.getProvider.returns(provider);
  multiProvider.getSigner.returns(signer);
  multiProvider.getSignerAddress.resolves(funder);
  multiProvider.getChainMetadata.returns({
    technicalStack: ChainTechnicalStack.ArbitrumNitro,
    nativeToken: { name: 'Hyperliquid', symbol: 'HYPE', decimals: 18 },
  });
  multiProvider.prepareTx.callsFake(async (_chain, transaction) => transaction);
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
  const receipt = {
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
  sendTransaction.resolves(receipt);
  const metrics = sinon.createStubInstance(KeyFunderMetrics);
  return {
    multiProvider,
    signer,
    estimateGas,
    sendTransaction,
    metrics,
    receipt,
  };
}

describe('KeyFunder Nitro transfers', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('tolerates parent-chain gas costs increasing after estimation', async () => {
    const { multiProvider, estimateGas, sendTransaction, receipt } = setup();
    // The failed Elysium transfer was estimated at 21,217 gas; the parent
    // data fee can increase before the next transaction is submitted.
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
      return receipt;
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

  for (const mode of [
    {
      name: 'legacy gas price',
      fees: { gasPrice: BigNumber.from(100_000_000) },
      feeCap: 100_000_000,
      threshold: '0.000002',
      target: '0.0000022',
    },
    {
      name: 'EIP-1559 fee cap',
      fees: {
        maxFeePerGas: BigNumber.from(200_000_000),
        maxPriorityFeePerGas: BigNumber.from(1_000_000),
      },
      feeCap: 200_000_000,
      threshold: '0.000004',
      target: '0.0000044',
    },
  ]) {
    it(`reserves buffered sweep gas using the ${mode.name}`, async () => {
      const balance = ethers.utils.parseEther('0.01');
      const target = ethers.utils.parseEther(mode.target);
      const gasBudget = BigNumber.from(23_338).mul(mode.feeCap);
      const { multiProvider, sendTransaction, signer, metrics, receipt } =
        setup(balance, mode.fees);
      // The old amount leaves less than the node's upfront gas requirement.
      expect(balance.sub(target).add(gasBudget).gt(balance)).to.equal(true);
      sendTransaction.callsFake(async (_chain, pendingTransaction) => {
        const transaction = await pendingTransaction;
        const value = BigNumber.from(transaction.value ?? 0);
        const limit = BigNumber.from(transaction.gasLimit ?? 0);
        const price = BigNumber.from(
          transaction.maxFeePerGas ?? transaction.gasPrice ?? mode.feeCap,
        );
        if (value.add(limit.mul(price)).gt(balance)) {
          throw new Error('insufficient funds for gas * price + value');
        }
        expect(value.gt(0)).to.equal(true);
        expect(balance.sub(value).sub(limit.mul(price)).eq(target)).to.equal(
          true,
        );
        return receipt;
      });
      const keyFunder = new KeyFunder(
        multiProvider,
        {
          version: '1',
          roles: {},
          chains: {
            elysium: {
              sweep: {
                enabled: true,
                address: recipient,
                threshold: mode.threshold,
                targetMultiplier: 1.1,
                triggerMultiplier: 1.2,
              },
            },
          },
        },
        { logger: pino({ level: 'silent' }), metrics },
      );

      await keyFunder.fundChain('elysium');

      expect(signer.populateTransaction.calledOnce).to.equal(true);
      sinon.assert.calledOnce(sendTransaction);
      expect(
        metrics.recordSweepAmount.calledOnceWithExactly(
          'elysium',
          parseFloat(
            ethers.utils.formatEther(balance.sub(target).sub(gasBudget)),
          ),
        ),
      ).to.equal(true);
    });
  }

  it('skips a sweep when the surplus cannot cover buffered gas', async () => {
    const { multiProvider, sendTransaction } = setup(
      ethers.utils.parseEther('0.000003'),
    );
    const keyFunder = new KeyFunder(
      multiProvider,
      {
        version: '1',
        roles: {},
        chains: {
          elysium: {
            sweep: {
              enabled: true,
              address: recipient,
              threshold: '0.000002',
              targetMultiplier: 1.1,
              triggerMultiplier: 1.2,
            },
          },
        },
      },
      { logger: pino({ level: 'silent' }) },
    );

    await keyFunder.fundChain('elysium');

    sinon.assert.notCalled(sendTransaction);
  });
});
