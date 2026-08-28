import { expect } from 'chai';
import sinon from 'sinon';
import { ethers } from 'ethers';
import { Connection, PublicKey } from '@solana/web3.js';
import { StargateClient } from '@cosmjs/stargate';
import { MultiProtocolBalanceMonitor } from '../src/core/MultiProtocolBalanceMonitor';
import { ChainFundingConfig, KeyfunderConfig } from '../src/types';

describe('MultiProtocolBalanceMonitor', () => {
  let monitor: MultiProtocolBalanceMonitor;

  beforeEach(() => {
    monitor = new MultiProtocolBalanceMonitor({ timeoutMs: 1000, retryCount: 1 });
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should query EVM native balance successfully', async () => {
    const mockProvider = sinon.createStubInstance(ethers.JsonRpcProvider);
    mockProvider.getBalance.resolves(ethers.parseEther('2.5'));

    const rpcUrl = 'http://localhost:8545';
    monitor.setEvmProvider(rpcUrl, mockProvider as any);

    const chainConfig: ChainFundingConfig = {
      protocol: 'ethereum',
      rpcUrl,
      recipients: [{ address: '0x1234567890123456789012345678901234567890' }],
    };

    const balance = await monitor.getNativeBalance(chainConfig, '0x1234567890123456789012345678901234567890');
    expect(balance).to.equal(ethers.parseEther('2.5'));
    expect(mockProvider.getBalance.calledOnce).to.be.true;
  });

  it('should query Solana native balance successfully', async () => {
    const mockConnection = sinon.createStubInstance(Connection);
    // 3.5 SOL in lamports = 3500000000
    mockConnection.getBalance.resolves(3500000000);

    const rpcUrl = 'https://api.devnet.solana.com';
    monitor.setSolanaConnection(rpcUrl, mockConnection as any);

    const testPubkey = '11111111111111111111111111111111';
    const chainConfig: ChainFundingConfig = {
      protocol: 'sealevel',
      rpcUrl,
      recipients: [{ address: testPubkey }],
    };

    const balance = await monitor.getNativeBalance(chainConfig, testPubkey);
    expect(balance).to.equal(3500000000n);
    expect(mockConnection.getBalance.calledOnce).to.be.true;
  });

  it('should query Cosmos native balance successfully via StargateClient', async () => {
    const mockClient = sinon.createStubInstance(StargateClient);
    mockClient.getBalance.resolves({ denom: 'uatom', amount: '5000000' });

    const rpcUrl = 'http://localhost:26657';
    monitor.setCosmosClient(rpcUrl, mockClient as any);

    const chainConfig: ChainFundingConfig = {
      protocol: 'cosmos',
      rpcUrl,
      strategyConfig: { type: 'direct', denom: 'uatom' },
      recipients: [{ address: 'cosmos1testrecipient' }],
    };

    const balance = await monitor.getNativeBalance(chainConfig, 'cosmos1testrecipient');
    expect(balance).to.equal(5000000n);
    expect(mockClient.getBalance.calledOnce).to.be.true;
  });

  it('should handle RPC failure and switch to fallback RPC', async () => {
    const primaryProvider = sinon.createStubInstance(ethers.JsonRpcProvider);
    primaryProvider.getBalance.rejects(new Error('Network connection timeout'));

    const fallbackProvider = sinon.createStubInstance(ethers.JsonRpcProvider);
    fallbackProvider.getBalance.resolves(ethers.parseEther('10.0'));

    monitor.setEvmProvider('http://primary.rpc', primaryProvider as any);
    monitor.setEvmProvider('http://fallback.rpc', fallbackProvider as any);

    const chainConfig: ChainFundingConfig = {
      protocol: 'ethereum',
      rpcUrl: 'http://primary.rpc',
      fallbackRpcUrls: ['http://fallback.rpc'],
      recipients: [{ address: '0x123' }],
    };

    const balance = await monitor.getNativeBalance(chainConfig, '0x123');
    expect(balance).to.equal(ethers.parseEther('10.0'));
    expect(primaryProvider.getBalance.called).to.be.true;
    expect(fallbackProvider.getBalance.calledOnce).to.be.true;
  });

  it('should batch query all recipient balances in getChainBalances', async () => {
    const mockProvider = sinon.createStubInstance(ethers.JsonRpcProvider);
    mockProvider.getBalance.withArgs('0xRecipient1').resolves(ethers.parseEther('0.1'));
    mockProvider.getBalance.withArgs('0xRecipient2').resolves(ethers.parseEther('1.5'));
    mockProvider.getBalance.withArgs('0xFunder').resolves(ethers.parseEther('50.0'));

    const rpcUrl = 'http://localhost:8545';
    monitor.setEvmProvider(rpcUrl, mockProvider as any);

    const chainConfig: ChainFundingConfig = {
      protocol: 'ethereum',
      rpcUrl,
      nativeDecimals: 18,
      recipients: [
        { address: '0xRecipient1', minBalance: '0.5', desiredBalance: '2.0' },
        { address: '0xRecipient2', minBalance: '0.5', desiredBalance: '2.0' },
      ],
    };

    const report = await monitor.getChainBalances('ethereum', chainConfig, '0xFunder');
    expect(report.funderBalance).to.equal(ethers.parseEther('50.0'));
    expect(report.recipientBalances).to.have.lengthOf(2);

    const rec1 = report.recipientBalances.find((r) => r.recipient === '0xRecipient1');
    expect(rec1?.needsFunding).to.be.true;
    expect(rec1?.deficit).to.equal(ethers.parseEther('1.9')); // 2.0 - 0.1

    const rec2 = report.recipientBalances.find((r) => r.recipient === '0xRecipient2');
    expect(rec2?.needsFunding).to.be.false;
    expect(rec2?.deficit).to.equal(0n);
  });

  it('should query all chains in getAllBalances', async () => {
    const mockEthProvider = sinon.createStubInstance(ethers.JsonRpcProvider);
    mockEthProvider.getBalance.resolves(ethers.parseEther('1.0'));
    monitor.setEvmProvider('http://eth.rpc', mockEthProvider as any);

    const mockSolConn = sinon.createStubInstance(Connection);
    mockSolConn.getBalance.resolves(2000000000);
    monitor.setSolanaConnection('http://sol.rpc', mockSolConn as any);

    const config: KeyfunderConfig = {
      chains: {
        ethereum: {
          protocol: 'ethereum',
          rpcUrl: 'http://eth.rpc',
          recipients: [{ address: '0x123' }],
        },
        solana: {
          protocol: 'sealevel',
          rpcUrl: 'http://sol.rpc',
          recipients: [{ address: '11111111111111111111111111111111' }],
        },
      },
    };

    const allReports = await monitor.getAllBalances(config);
    expect(allReports).to.have.property('ethereum');
    expect(allReports).to.have.property('solana');
    expect(allReports.ethereum.recipientBalances[0].balance).to.equal(ethers.parseEther('1.0'));
    expect(allReports.solana.recipientBalances[0].balance).to.equal(2000000000n);
  });
});
