import { expect } from 'chai';
import { BigNumber, ethers } from 'ethers';
import { pino, type Logger } from 'pino';
import sinon from 'sinon';

import { MultiProvider } from '@hyperlane-xyz/sdk';

import type { KeyFunderConfig } from '../config/types.js';
import { KeyFunderMetrics } from '../metrics/Metrics.js';

import { KeyFunder } from './KeyFunder.js';

describe('KeyFunder', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('scales the funder balance metric by the chain native token decimals', async () => {
    const logger = {
      child: () => logger,
      debug: () => undefined,
      error: () => undefined,
      info: () => undefined,
      warn: () => undefined,
    } as unknown as Logger;

    const multiProvider = sinon.createStubInstance(MultiProvider);
    // 1152 TRX at 6 decimals = 1_152_000_000 sun.
    multiProvider.getSigner.returns({
      getAddress: async () => '0x2222222222222222222222222222222222222222',
      getBalance: async () => BigNumber.from('1152000000'),
    } as never);
    multiProvider.getChainMetadata.returns({
      nativeToken: { name: 'TRON', symbol: 'TRX', decimals: 6 },
    });

    const recordUnifiedWalletBalance = sinon.spy();
    const metrics = {
      recordUnifiedWalletBalance,
    } as unknown as KeyFunderMetrics;

    const config: KeyFunderConfig = {
      version: '1',
      roles: {},
      chains: { tron: {} },
    };

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger,
      metrics,
    });

    await (
      keyFunder as unknown as {
        recordFunderBalance: (chain: string) => Promise<void>;
      }
    ).recordFunderBalance('tron');

    sinon.assert.calledOnceWithExactly(
      recordUnifiedWalletBalance,
      'tron',
      '0x2222222222222222222222222222222222222222',
      'key-funder',
      1152,
    );
  });

  it('scales the funding amount by the chain native token decimals', async () => {
    // CAST: minimal pino Logger double; the funder only calls child() and the
    // level methods, so a full Logger is unnecessary here.
    const logger = {
      child: () => logger,
      debug: () => undefined,
      error: () => undefined,
      info: () => undefined,
      warn: () => undefined,
    } as unknown as Logger;

    const multiProvider = sinon.createStubInstance(MultiProvider);

    // Recipient key is empty, so it must be topped up to its desired balance.
    const provider = sinon.createStubInstance(ethers.providers.JsonRpcProvider);
    provider.getBalance.resolves(BigNumber.from(0));
    multiProvider.getProvider.returns(provider);

    // Funder holds 2747 TRX (6 decimals). Under the old 18-decimal bug this
    // would have been read as 2747e-12 TRX and falsely flagged as insufficient.
    const signer = sinon.createStubInstance(ethers.Wallet);
    signer.getAddress.resolves('0x3333333333333333333333333333333333333333');
    signer.getBalance.resolves(BigNumber.from('2747000000'));
    multiProvider.getSigner.returns(signer);
    multiProvider.getSignerAddress.resolves(
      '0x3333333333333333333333333333333333333333',
    );

    multiProvider.getChainMetadata.returns({
      nativeToken: { name: 'TRON', symbol: 'TRX', decimals: 6 },
    });
    const sendTransaction = sinon.stub<
      Parameters<MultiProvider['sendTransaction']>,
      ReturnType<MultiProvider['sendTransaction']>
    >();
    // CAST: fundKey only reads transactionHash off the receipt.
    sendTransaction.resolves({
      transactionHash: '0xabc',
    } as unknown as ethers.ContractReceipt);
    multiProvider.sendTransaction = sendTransaction;
    multiProvider.tryGetExplorerTxUrl.returns(null);

    const config: KeyFunderConfig = {
      version: '1',
      roles: {
        relayer: { address: '0x1111111111111111111111111111111111111111' },
      },
      chains: { tron: { balances: { relayer: '1000' } } },
    };

    const keyFunder = new KeyFunder(multiProvider, config, { logger });

    await keyFunder.fundChain('tron');

    // 1000 TRX at 6 decimals = 1_000_000_000 sun.
    sinon.assert.calledOnce(sendTransaction);
    const tx = await Promise.resolve(sendTransaction.firstCall.args[1]);
    expect(tx.value?.toString()).to.equal('1000000000');
  });

  it('should continue funding when recordFunderBalance fails', async () => {
    const chainWarnSpy = sinon.spy();
    const chainInfoSpy = sinon.spy();

    const chainLogger = {
      child: () => chainLogger,
      debug: () => undefined,
      error: () => undefined,
      info: (...args: unknown[]) => chainInfoSpy(...args),
      warn: (...args: unknown[]) => chainWarnSpy(...args),
    } as unknown as Logger;

    const logger = {
      child: () => chainLogger,
      debug: () => undefined,
      error: () => undefined,
      info: () => undefined,
      warn: () => undefined,
    } as unknown as Logger;

    const multiProvider = sinon.createStubInstance(MultiProvider);

    const config: KeyFunderConfig = {
      version: '1',
      roles: {
        relayer: { address: '0x1111111111111111111111111111111111111111' },
      },
      chains: {
        ethereum: {
          balances: {
            relayer: '1',
          },
        },
      },
    };

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger,
    });
    const recordFunderBalanceStub = sinon.stub(
      keyFunder as unknown as {
        recordFunderBalance: (chain: string) => Promise<void>;
      },
      'recordFunderBalance',
    );
    recordFunderBalanceStub.rejects(new Error('RPC failure'));

    const fundKeysStub = sinon.stub(
      keyFunder as unknown as {
        fundKeys: (chain: string, keys: unknown[]) => Promise<void>;
      },
      'fundKeys',
    );
    fundKeysStub.resolves();

    await keyFunder.fundChain('ethereum');

    sinon.assert.calledOnce(recordFunderBalanceStub);
    sinon.assert.calledOnce(fundKeysStub);
    sinon.assert.calledOnce(chainWarnSpy);
    const warnArgs = chainWarnSpy.firstCall.args;
    expect(warnArgs[1]).to.equal(
      'Failed to record funder balance metric, continuing',
    );
    expect((warnArgs[0] as { error: unknown }).error).to.be.instanceOf(Error);

    sinon.assert.calledOnce(chainInfoSpy);
    const infoArgs = chainInfoSpy.firstCall.args;
    expect(infoArgs[1]).to.equal('Chain funding completed');
    expect(
      (infoArgs[0] as { durationSeconds: unknown }).durationSeconds,
    ).to.be.a('number');
  });
});

describe('KeyFunder recipient balance reads', () => {
  const chain = 'ethereum';
  const recipient = `0x${'12'.repeat(20)}`;
  const funder = `0x${'34'.repeat(20)}`;
  const units = ethers.utils.parseEther;

  function setup(balance: string) {
    const provider = sinon.createStubInstance(ethers.providers.JsonRpcProvider);
    const getBalance = sinon
      .stub<
        Parameters<ethers.providers.JsonRpcProvider['getBalance']>,
        ReturnType<ethers.providers.JsonRpcProvider['getBalance']>
      >()
      .resolves(units(balance));
    provider.getBalance = getBalance;
    const signer = sinon.createStubInstance(ethers.Wallet);
    signer.getAddress.resolves(funder);
    signer.getBalance.resolves(units('1000'));
    const multiProvider = sinon.createStubInstance(MultiProvider);
    multiProvider.getProvider.returns(provider);
    multiProvider.getSigner.returns(signer);
    multiProvider.getSignerAddress.resolves(funder);
    multiProvider.getChainMetadata.returns({
      nativeToken: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    });
    const sendTransaction = sinon.stub<
      Parameters<MultiProvider['sendTransaction']>,
      ReturnType<MultiProvider['sendTransaction']>
    >();
    multiProvider.sendTransaction = sendTransaction;
    sendTransaction.resolves({
      to: recipient,
      from: funder,
      contractAddress: ethers.constants.AddressZero,
      transactionIndex: 0,
      gasUsed: BigNumber.from(0),
      logsBloom: '0x',
      blockHash: ethers.constants.HashZero,
      transactionHash: ethers.constants.HashZero,
      logs: [],
      blockNumber: 1,
      confirmations: 1,
      cumulativeGasUsed: BigNumber.from(0),
      effectiveGasPrice: BigNumber.from(0),
      byzantium: true,
      type: 2,
    });
    const metrics = sinon.createStubInstance(KeyFunderMetrics);
    const recordWalletBalance = sinon.stub<
      Parameters<KeyFunderMetrics['recordWalletBalance']>,
      ReturnType<KeyFunderMetrics['recordWalletBalance']>
    >();
    metrics.recordWalletBalance = recordWalletBalance;
    const config: KeyFunderConfig = {
      version: '1',
      roles: { relayer: { address: recipient } },
      chains: { [chain]: { balances: { relayer: '100' } } },
    };
    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: pino({ level: 'silent' }),
      metrics,
    });
    return {
      keyFunder,
      getBalance,
      sendTransaction,
      recordWalletBalance,
      config,
    };
  }

  afterEach(() => {
    sinon.restore();
  });

  for (const [balance, expectedFunding] of [
    ['110', '0'],
    ['100', '0'],
    ['99', '0'],
    ['40', '0'],
    ['39', '61'],
    ['0', '100'],
  ]) {
    it(`uses one balance read and preserves funding threshold at ${balance}/100`, async () => {
      const { keyFunder, getBalance, sendTransaction, recordWalletBalance } =
        setup(balance);
      await keyFunder.fundChain(chain);
      sinon.assert.calledOnceWithExactly(getBalance, recipient);
      sinon.assert.calledOnceWithExactly(
        recordWalletBalance,
        chain,
        recipient,
        'relayer',
        Number(balance),
      );
      if (expectedFunding === '0') {
        sinon.assert.notCalled(sendTransaction);
      } else {
        sinon.assert.calledOnce(sendTransaction);
        const tx = await sendTransaction.firstCall.args[1];
        expect(tx.value?.toString()).to.equal(
          units(expectedFunding).toString(),
        );
      }
    });
  }

  it('reads fresh balances for subsequent cycles', async () => {
    const { keyFunder, getBalance, sendTransaction } = setup('0');
    getBalance.onCall(1).resolves(units('100'));
    await keyFunder.fundChain(chain);
    await keyFunder.fundChain(chain);
    sinon.assert.calledTwice(getBalance);
    sinon.assert.calledOnce(sendTransaction);
  });

  it('reads fresh balances for a second role sharing the same address after funding', async () => {
    const { keyFunder, getBalance, sendTransaction, config } = setup('0');
    config.roles.validator = { address: recipient };
    config.chains[chain].balances = { relayer: '100', validator: '100' };
    getBalance.onCall(1).resolves(units('100'));
    await keyFunder.fundChain(chain);
    sinon.assert.calledTwice(getBalance);
    sinon.assert.calledOnce(sendTransaction);
  });

  it('propagates recipient balance failure without funding', async () => {
    const { keyFunder, getBalance, sendTransaction } = setup('0');
    const failure = new Error('balance unavailable');
    getBalance.rejects(failure);
    try {
      await keyFunder.fundChain(chain);
      expect.fail('Expected balance failure');
    } catch (error) {
      expect(error).to.equal(failure);
    }
    sinon.assert.notCalled(sendTransaction);
  });
});
