import { expect } from 'chai';
import sinon from 'sinon';
import { ethers } from 'ethers';
import { DirectNativeStrategy } from '../../src/strategies/DirectNativeStrategy';
import { FundingAction, StrategyExecutionContext } from '../../src/types';

describe('DirectNativeStrategy', () => {
  let strategy: DirectNativeStrategy;

  beforeEach(() => {
    strategy = new DirectNativeStrategy();
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should execute EVM direct native transfer successfully', async () => {
    const mockSigner = {
      sendTransaction: sinon.stub().resolves({
        hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        wait: sinon.stub().resolves({
          gasUsed: 21000n,
          gasPrice: ethers.parseUnits('30', 'gwei'),
        }),
      }),
    };

    const action: FundingAction = {
      chain: 'ethereum',
      protocol: 'ethereum',
      recipient: '0x1234567890123456789012345678901234567890',
      currentBalance: 0n,
      formattedCurrentBalance: '0.0',
      minThreshold: ethers.parseEther('0.5'),
      formattedMinThreshold: '0.5',
      desiredBalance: ethers.parseEther('2.0'),
      formattedDesiredBalance: '2.0',
      requiredFunding: ethers.parseEther('2.0'),
      formattedRequiredFunding: '2.0',
      funderAddress: '0xFunder',
      funderBalance: ethers.parseEther('100.0'),
      formattedFunderBalance: '100.0',
      strategy: 'direct',
      status: 'PENDING',
      decimals: 18,
      symbol: 'ETH',
    };

    const context: StrategyExecutionContext = {
      chainConfig: {
        protocol: 'ethereum',
        recipients: [],
      },
      funderConfig: { type: 'privateKey' },
    };

    const result = await strategy.execute(action, context, { signer: mockSigner });
    expect(result.success).to.be.true;
    expect(result.txHash).to.equal('0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');
    expect(result.gasUsed).to.equal(21000n);
  });

  it('should return error if signer is missing for EVM', async () => {
    const action: FundingAction = {
      chain: 'ethereum',
      protocol: 'ethereum',
      recipient: '0x123',
      currentBalance: 0n,
      formattedCurrentBalance: '0.0',
      minThreshold: 0n,
      formattedMinThreshold: '0',
      desiredBalance: 100n,
      formattedDesiredBalance: '100',
      requiredFunding: 100n,
      formattedRequiredFunding: '100',
      funderAddress: '0xFunder',
      funderBalance: 1000n,
      formattedFunderBalance: '1000',
      strategy: 'direct',
      status: 'PENDING',
      decimals: 18,
      symbol: 'ETH',
    };

    const context: StrategyExecutionContext = {
      chainConfig: { protocol: 'ethereum', recipients: [] },
      funderConfig: { type: 'privateKey' },
    };

    const result = await strategy.execute(action, context, {});
    expect(result.success).to.be.false;
    expect(result.error).to.include('Signer is required');
  });

  it('should handle CosmJS transfer execution', async () => {
    const mockStargateClient = {
      sendTokens: sinon.stub().resolves({
        code: 0,
        transactionHash: 'COSMOS_TX_HASH_123',
        gasUsed: 80000n,
        rawLog: '',
      }),
    };

    const action: FundingAction = {
      chain: 'cosmos',
      protocol: 'cosmos',
      recipient: 'cosmos1recipientaddress',
      currentBalance: 0n,
      formattedCurrentBalance: '0',
      minThreshold: 1000000n,
      formattedMinThreshold: '1.0',
      desiredBalance: 5000000n,
      formattedDesiredBalance: '5.0',
      requiredFunding: 5000000n,
      formattedRequiredFunding: '5.0',
      funderAddress: 'cosmos1funderaddress',
      funderBalance: 100000000n,
      formattedFunderBalance: '100.0',
      strategy: 'direct',
      status: 'PENDING',
      decimals: 6,
      symbol: 'ATOM',
      tokenDenom: 'uatom',
    };

    const context: StrategyExecutionContext = {
      chainConfig: { protocol: 'cosmos', recipients: [] },
      funderConfig: { type: 'privateKey' },
    };

    const result = await strategy.execute(action, context, {
      stargateClient: mockStargateClient,
      funderAddress: 'cosmos1funderaddress',
    });

    expect(result.success).to.be.true;
    expect(result.txHash).to.equal('COSMOS_TX_HASH_123');
    expect(mockStargateClient.sendTokens.calledOnce).to.be.true;
  });
});
