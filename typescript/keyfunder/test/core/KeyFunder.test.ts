import { expect } from 'chai';
import sinon from 'sinon';
import { ethers } from 'ethers';
import { KeyFunder } from '../../src/core/KeyFunder';
import { MultiProtocolBalanceMonitor } from '../../src/core/MultiProtocolBalanceMonitor';
import { PolicyEvaluator } from '../../src/core/PolicyEvaluator';
import { TransactionExecutor } from '../../src/execution/TransactionExecutor';
import { KeyfunderMetrics } from '../../src/metrics/metrics';
import { KeyfunderConfig } from '../../src/types';

describe('KeyFunder Core Orchestrator', () => {
  let keyfunder: KeyFunder;
  let mockMonitor: any;
  let mockEvaluator: any;
  let mockExecutor: any;
  let metrics: KeyfunderMetrics;

  const validConfig: KeyfunderConfig = {
    funder: {
      type: 'privateKey',
      key: '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    },
    chains: {
      ethereum: {
        protocol: 'ethereum',
        rpcUrl: 'http://localhost:8545',
        recipients: [
          {
            name: 'relayer-1',
            address: '0x1111111111111111111111111111111111111111',
            minBalance: '0.5',
            desiredBalance: '2.0',
          },
        ],
      },
    },
    dryRun: false,
  };

  beforeEach(() => {
    mockMonitor = sinon.createStubInstance(MultiProtocolBalanceMonitor);
    mockEvaluator = sinon.createStubInstance(PolicyEvaluator);
    mockExecutor = sinon.createStubInstance(TransactionExecutor);
    metrics = new KeyfunderMetrics();

    mockMonitor.getAllBalances.resolves({
      ethereum: {
        chain: 'ethereum',
        protocol: 'ethereum',
        funderAddress: '0xFunder',
        funderBalance: ethers.parseEther('10.0'),
        formattedFunderBalance: '10.0',
        recipientBalances: [
          {
            recipient: '0x1111111111111111111111111111111111111111',
            name: 'relayer-1',
            balance: ethers.parseEther('0.1'),
            formattedBalance: '0.1',
            minBalance: ethers.parseEther('0.5'),
            formattedMinBalance: '0.5',
            desiredBalance: ethers.parseEther('2.0'),
            formattedDesiredBalance: '2.0',
            needsFunding: true,
            deficit: ethers.parseEther('1.9'),
            formattedDeficit: '1.9',
          },
        ],
      },
    });

    keyfunder = new KeyFunder(validConfig, {
      balanceMonitor: mockMonitor,
      policyEvaluator: mockEvaluator,
      executor: mockExecutor,
      metrics,
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should run check without executing any transactions', async () => {
    mockEvaluator.evaluateAll.returns([
      {
        chain: 'ethereum',
        protocol: 'ethereum',
        recipient: '0x1111111111111111111111111111111111111111',
        currentBalance: ethers.parseEther('0.1'),
        formattedCurrentBalance: '0.1',
        minThreshold: ethers.parseEther('0.5'),
        formattedMinThreshold: '0.5',
        desiredBalance: ethers.parseEther('2.0'),
        formattedDesiredBalance: '2.0',
        requiredFunding: ethers.parseEther('1.9'),
        formattedRequiredFunding: '1.9',
        funderAddress: '0xFunder',
        funderBalance: ethers.parseEther('10.0'),
        formattedFunderBalance: '10.0',
        strategy: 'direct',
        status: 'PENDING',
        decimals: 18,
        symbol: 'ETH',
      },
    ]);

    const result = await keyfunder.check();
    expect(result.reports).to.have.property('ethereum');
    expect(result.actions).to.have.lengthOf(1);
    expect(result.actions[0].status).to.equal('PENDING');
    expect(mockExecutor.executeAll.called).to.be.false;
  });

  it('should execute funding actions in runOnce', async () => {
    const pendingAction = {
      chain: 'ethereum',
      protocol: 'ethereum',
      recipient: '0x1111111111111111111111111111111111111111',
      currentBalance: ethers.parseEther('0.1'),
      formattedCurrentBalance: '0.1',
      minThreshold: ethers.parseEther('0.5'),
      formattedMinThreshold: '0.5',
      desiredBalance: ethers.parseEther('2.0'),
      formattedDesiredBalance: '2.0',
      requiredFunding: ethers.parseEther('1.9'),
      formattedRequiredFunding: '1.9',
      funderAddress: '0xFunder',
      funderBalance: ethers.parseEther('10.0'),
      formattedFunderBalance: '10.0',
      strategy: 'direct',
      status: 'PENDING' as const,
      decimals: 18,
      symbol: 'ETH',
    };

    mockEvaluator.evaluateAll.returns([pendingAction]);
    mockExecutor.executeAll.resolves([
      {
        ...pendingAction,
        status: 'EXECUTED',
        txHash: '0xEXECUTED_HASH_123',
      },
    ]);

    const result = await keyfunder.runOnce();
    expect(result.actions[0].status).to.equal('EXECUTED');
    expect(result.actions[0].txHash).to.equal('0xEXECUTED_HASH_123');
    expect(mockExecutor.executeAll.calledOnce).to.be.true;
  });

  it('should simulate execution in dry-run mode without sending transactions', async () => {
    const dryRunConfig: KeyfunderConfig = {
      ...validConfig,
      dryRun: true,
    };

    const dryRunKeyfunder = new KeyFunder(dryRunConfig, {
      balanceMonitor: mockMonitor,
      policyEvaluator: mockEvaluator,
      executor: mockExecutor,
      metrics,
    });

    const pendingAction = {
      chain: 'ethereum',
      protocol: 'ethereum',
      recipient: '0x1111111111111111111111111111111111111111',
      currentBalance: ethers.parseEther('0.1'),
      formattedCurrentBalance: '0.1',
      minThreshold: ethers.parseEther('0.5'),
      formattedMinThreshold: '0.5',
      desiredBalance: ethers.parseEther('2.0'),
      formattedDesiredBalance: '2.0',
      requiredFunding: ethers.parseEther('1.9'),
      formattedRequiredFunding: '1.9',
      funderAddress: '0xFunder',
      funderBalance: ethers.parseEther('10.0'),
      formattedFunderBalance: '10.0',
      strategy: 'direct',
      status: 'PENDING' as const,
      decimals: 18,
      symbol: 'ETH',
    };

    mockEvaluator.evaluateAll.returns([pendingAction]);

    const result = await dryRunKeyfunder.runOnce();
    expect(result.actions[0].status).to.equal('EXECUTED');
    expect(result.actions[0].txHash).to.include('dryrun');
    expect(mockExecutor.executeAll.called).to.be.false;
  });

  it('should perform manual topUpRecipient properly', async () => {
    mockMonitor.getNativeBalance.resolves(ethers.parseEther('1.0'));
    mockExecutor.executeAction.resolves({
      success: true,
      txHash: '0xTOPUP_TX_HASH',
    });

    const action = await keyfunder.topUpRecipient(
      'ethereum',
      '0x1111111111111111111111111111111111111111',
      '0.5'
    );

    expect(action.status).to.equal('EXECUTED');
    expect(action.txHash).to.equal('0xTOPUP_TX_HASH');
    expect(action.requiredFunding).to.equal(ethers.parseEther('0.5'));
    expect(mockExecutor.executeAction.calledOnce).to.be.true;
  });
});
