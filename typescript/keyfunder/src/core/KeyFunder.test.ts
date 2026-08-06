import { expect } from 'chai';
import { BigNumber, ethers } from 'ethers';
import type { ChainMetadata } from '@hyperlane-xyz/sdk';
import type { Logger } from 'pino';
import sinon from 'sinon';

import { MultiProvider } from '@hyperlane-xyz/sdk';

import type { KeyFunderConfig } from '../config/types.js';
import type { KeyFunderMetrics } from '../metrics/Metrics.js';

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
    } as never);

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

    // CAST: getNativeDecimals only reads nativeToken.decimals; the rest of
    // ChainMetadata is irrelevant to this test.
    multiProvider.getChainMetadata.returns({
      nativeToken: { name: 'TRON', symbol: 'TRX', decimals: 6 },
    } as unknown as ChainMetadata);
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
