import { expect } from 'chai';
import sinon from 'sinon';
import { ethers } from 'ethers';
import { RollupBridgeStrategy } from '../../src/strategies/RollupBridgeStrategy';
import { FundingAction, StrategyExecutionContext } from '../../src/types';

describe('RollupBridgeStrategy', () => {
  let strategy: RollupBridgeStrategy;

  beforeEach(() => {
    strategy = new RollupBridgeStrategy();
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should execute OP Stack depositTransaction successfully', async () => {
    const mockSigner = {};
    const mockPortalContract = {
      depositTransaction: sinon.stub().resolves({
        hash: '0xOP_DEPOSIT_TX_123',
        wait: sinon.stub().resolves({ gasUsed: 95000n }),
      }),
    };

    sinon.stub(strategy, 'getContract').callsFake(() => mockPortalContract as any);

    const action: FundingAction = {
      chain: 'optimism',
      protocol: 'ethereum',
      recipient: '0x1111111111111111111111111111111111111111',
      currentBalance: 0n,
      formattedCurrentBalance: '0.0',
      minThreshold: 100n,
      formattedMinThreshold: '100',
      desiredBalance: 1000n,
      formattedDesiredBalance: '1000',
      requiredFunding: ethers.parseEther('0.75'),
      formattedRequiredFunding: '0.75',
      funderAddress: '0xFunder',
      funderBalance: ethers.parseEther('50.0'),
      formattedFunderBalance: '50.0',
      strategy: 'opStackBridge',
      status: 'PENDING',
      decimals: 18,
      symbol: 'ETH',
    };

    const context: StrategyExecutionContext = {
      chainConfig: {
        protocol: 'ethereum',
        recipients: [],
        strategyConfig: {
          type: 'opStackBridge',
          portalAddress: '0xOptimismPortalAddress12345678901234567890',
          l2GasLimit: 300000,
        },
      },
      funderConfig: { type: 'privateKey' },
    };

    const result = await strategy.execute(action, context, { signer: mockSigner });
    expect(result.success).to.be.true;
    expect(result.txHash).to.equal('0xOP_DEPOSIT_TX_123');

    expect(mockPortalContract.depositTransaction.calledOnce).to.be.true;
    const args = mockPortalContract.depositTransaction.firstCall.args;
    expect(args[0]).to.equal(action.recipient);
    expect(args[1]).to.equal(ethers.parseEther('0.75'));
    expect(args[2]).to.equal(300000); // l2GasLimit
    expect(args[5].value).to.equal(ethers.parseEther('0.75'));
  });

  it('should execute Arbitrum createRetryableTicket successfully', async () => {
    const mockSigner = {
      getAddress: sinon.stub().resolves('0xFunderSignerAddress123'),
    };

    const mockInboxContract = {
      createRetryableTicket: sinon.stub().resolves({
        hash: '0xARB_RETRYABLE_TX_123',
        wait: sinon.stub().resolves({ gasUsed: 120000n }),
      }),
    };

    sinon.stub(strategy, 'getContract').callsFake(() => mockInboxContract as any);

    const action: FundingAction = {
      chain: 'arbitrum',
      protocol: 'ethereum',
      recipient: '0x2222222222222222222222222222222222222222',
      currentBalance: 0n,
      formattedCurrentBalance: '0.0',
      minThreshold: 100n,
      formattedMinThreshold: '100',
      desiredBalance: 1000n,
      formattedDesiredBalance: '1000',
      requiredFunding: ethers.parseEther('1.2'),
      formattedRequiredFunding: '1.2',
      funderAddress: '0xFunder',
      funderBalance: ethers.parseEther('50.0'),
      formattedFunderBalance: '50.0',
      strategy: 'arbitrumInbox',
      status: 'PENDING',
      decimals: 18,
      symbol: 'ETH',
    };

    const context: StrategyExecutionContext = {
      chainConfig: {
        protocol: 'ethereum',
        recipients: [],
        strategyConfig: {
          type: 'arbitrumInbox',
          inboxAddress: '0xArbitrumInboxAddress12345678901234567890',
          maxGas: '100000',
          gasPriceBid: '0.1', // 0.1 Gwei
        },
      },
      funderConfig: { type: 'privateKey' },
    };

    const result = await strategy.execute(action, context, { signer: mockSigner });
    expect(result.success).to.be.true;
    expect(result.txHash).to.equal('0xARB_RETRYABLE_TX_123');
    expect(mockInboxContract.createRetryableTicket.calledOnce).to.be.true;
  });
});
