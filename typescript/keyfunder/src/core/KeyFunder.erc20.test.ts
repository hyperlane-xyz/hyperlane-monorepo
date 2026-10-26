import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { BigNumber, ethers } from 'ethers';
import { pino } from 'pino';
import sinon from 'sinon';

import {
  ERC20__factory,
  InterchainGasPaymaster__factory,
  ProxyAdmin__factory,
  StorageGasOracle__factory,
} from '@hyperlane-xyz/core';
import { HyperlaneIgp, MultiProvider } from '@hyperlane-xyz/sdk';

import type { KeyFunderConfig } from '../config/types.js';
import { KeyFunderMetrics } from '../metrics/Metrics.js';

import { KeyFunder } from './KeyFunder.js';

chai.use(chaiAsPromised);

describe('KeyFunder ERC20 gas tokens', () => {
  const tokenAddress = '0x20c0000000000000000000000000000000000000';
  const recipient = `0x${'12'.repeat(20)}`;
  const funder = `0x${'34'.repeat(20)}`;
  const igpAddress = `0x${'56'.repeat(20)}`;
  const sweepAddress = `0x${'78'.repeat(20)}`;
  const units = (value: string) => ethers.utils.parseUnits(value, 6);
  const tokenInterface = ERC20__factory.createInterface();

  afterEach(() => {
    sinon.restore();
  });

  function setup(
    recipientBalance = '0',
    funderBalance = '100',
    igpBalance = '0',
  ) {
    const provider = new ethers.providers.JsonRpcProvider();
    sinon.stub(provider, 'call').callsFake(async (transaction) => {
      const data = await transaction.data;
      if (typeof data !== 'string') throw new Error('Missing call data');
      const { args, name } = tokenInterface.parseTransaction({ data });
      if (name !== 'balanceOf') throw new Error(`Unexpected call: ${name}`);
      const account = String(args[0]).toLowerCase();
      const balance =
        account === funder.toLowerCase()
          ? funderBalance
          : account === igpAddress.toLowerCase()
            ? igpBalance
            : recipientBalance;
      return tokenInterface.encodeFunctionResult('balanceOf', [units(balance)]);
    });
    const nativeBalance = sinon
      .stub(provider, 'getBalance')
      .rejects(new Error('Tempo native balances are placeholders'));
    const signer = sinon.createStubInstance(ethers.Wallet);
    signer.getAddress.resolves(funder);
    signer.getBalance.rejects(new Error('Must read token balance'));
    const multiProvider = sinon.createStubInstance(MultiProvider);
    multiProvider.getProvider.returns(provider);
    multiProvider.getSigner.returns(signer);
    multiProvider.getSignerAddress.resolves(funder);
    multiProvider.sendTransaction.resolves({
      to: tokenAddress,
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
    const config: KeyFunderConfig = {
      version: '1',
      roles: { relayer: { address: recipient } },
      chains: {
        tempo: {
          erc20GasToken: { address: tokenAddress, decimals: 6 },
          balances: { relayer: '10' },
        },
      },
    };
    const metrics = sinon.createStubInstance(KeyFunderMetrics);
    const igp = new HyperlaneIgp(
      {
        tempo: {
          interchainGasPaymaster: InterchainGasPaymaster__factory.connect(
            igpAddress,
            provider,
          ),
          storageGasOracle: StorageGasOracle__factory.connect(
            igpAddress,
            provider,
          ),
          proxyAdmin: ProxyAdmin__factory.connect(igpAddress, provider),
        },
      },
      multiProvider,
    );
    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: pino({ level: 'silent' }),
      metrics,
      igp,
    });
    return { keyFunder, config, metrics, multiProvider, nativeBalance, signer };
  }

  it('funds the token deficit at six decimals and records token balances', async () => {
    const { keyFunder, metrics, multiProvider, nativeBalance, signer } =
      setup('2');
    await keyFunder.fundChain('tempo');
    const [chain, pendingTransaction] =
      multiProvider.sendTransaction.firstCall.args;
    const transaction = await pendingTransaction;
    expect(chain).to.equal('tempo');
    expect(transaction.to).to.equal(ethers.utils.getAddress(tokenAddress));
    expect(transaction.value).to.equal(undefined);
    if (!transaction.data) throw new Error('Missing transaction data');
    expect(
      tokenInterface
        .decodeFunctionData('transfer', transaction.data)
        .toString(),
    ).to.equal(`${recipient},${units('8').toString()}`);
    expect(
      metrics.recordWalletBalance.calledWith('tempo', recipient, 'relayer', 2),
    ).to.equal(true);
    expect(
      metrics.recordUnifiedWalletBalance.calledWith(
        'tempo',
        funder,
        'key-funder',
        100,
      ),
    ).to.equal(true);
    expect(
      metrics.recordFundingAmount.calledWith('tempo', recipient, 'relayer', 8),
    ).to.equal(true);
    sinon.assert.notCalled(nativeBalance);
    expect(signer.getBalance.called).to.equal(false);
  });

  it('skips recipients above the funding trigger', async () => {
    const { keyFunder, multiProvider } = setup('5');
    await keyFunder.fundChain('tempo');
    expect(multiProvider.sendTransaction.called).to.equal(false);
  });

  it('rejects insufficient token funds despite the placeholder native balance', async () => {
    const { keyFunder, multiProvider } = setup('0', '1');
    await expect(keyFunder.fundChain('tempo')).to.be.rejectedWith(
      'Insufficient funder balance on tempo',
    );
    expect(multiProvider.sendTransaction.called).to.equal(false);
  });

  it('propagates transfer failures without recording successful funding', async () => {
    const { keyFunder, multiProvider, metrics } = setup();
    multiProvider.sendTransaction.rejects(new Error('Token transfer rejected'));
    await expect(keyFunder.fundChain('tempo')).to.be.rejectedWith(
      'Token transfer rejected',
    );
    expect(metrics.recordFundingAmount.called).to.equal(false);
  });

  it('claims token IGP fees with claimToken', async () => {
    const { keyFunder, config, multiProvider, metrics } = setup(
      '10',
      '100',
      '3',
    );
    config.chains.tempo.igp = { address: igpAddress, claimThreshold: '2' };
    await keyFunder.fundChain('tempo');
    const [, pendingTransaction] = multiProvider.sendTransaction.firstCall.args;
    const transaction = await pendingTransaction;
    expect(transaction.to).to.equal(ethers.utils.getAddress(igpAddress));
    if (!transaction.data) throw new Error('Missing transaction data');
    expect(
      InterchainGasPaymaster__factory.createInterface().decodeFunctionData(
        'claimToken',
        transaction.data,
      )[0],
    ).to.equal(ethers.utils.getAddress(tokenAddress));
    expect(metrics.recordIgpBalance.calledWith('tempo', 3)).to.equal(true);
  });

  it('sweeps token surplus while retaining the configured target', async () => {
    const { keyFunder, config, multiProvider } = setup('10');
    config.chains.tempo.sweep = {
      enabled: true,
      address: sweepAddress,
      threshold: '10',
      targetMultiplier: 1.5,
      triggerMultiplier: 2,
    };
    await keyFunder.fundChain('tempo');
    const [, pendingTransaction] = multiProvider.sendTransaction.firstCall.args;
    const transaction = await pendingTransaction;
    expect(transaction.to).to.equal(ethers.utils.getAddress(tokenAddress));
    expect(transaction.value).to.equal(undefined);
    if (!transaction.data) throw new Error('Missing transaction data');
    expect(
      tokenInterface
        .decodeFunctionData('transfer', transaction.data)
        .toString(),
    ).to.equal(`${sweepAddress},${units('85').toString()}`);
  });
});
