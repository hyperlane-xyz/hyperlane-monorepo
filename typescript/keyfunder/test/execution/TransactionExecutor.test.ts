import { expect } from 'chai';
import sinon from 'sinon';
import { ethers } from 'ethers';
import { TransactionExecutor } from '../../src/execution/TransactionExecutor';
import { NonceManager } from '../../src/execution/NonceManager';
import { GasPriceManager } from '../../src/execution/GasPriceManager';
import { StrategyRouter } from '../../src/strategies/StrategyRouter';
import { MultiProtocolBalanceMonitor } from '../../src/core/MultiProtocolBalanceMonitor';
import { FundingAction, KeyfunderConfig } from '../../src/types';

describe('TransactionExecutor', () => {
  let executor: TransactionExecutor;
  let nonceManager: NonceManager;
  let gasPriceManager: GasPriceManager;
  let strategyRouter: StrategyRouter;
  let balanceMonitor: MultiProtocolBalanceMonitor;
  let mockProvider: any;

  beforeEach(() => {
    nonceManager = new NonceManager();
    gasPriceManager = new GasPriceManager();
    strategyRouter = new StrategyRouter();
    balanceMonitor = new MultiProtocolBalanceMonitor();

    mockProvider = sinon.createStubInstance(ethers.JsonRpcProvider);
    mockProvider.getTransactionCount.resolves(0);
    mockProvider.getFeeData.resolves({
      maxFeePerGas: ethers.parseUnits('20', 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits('1.5', 'gwei'),
      gasPrice: null,
    });

    balanceMonitor.setEvmProvider('http://localhost:8545', mockProvider as any);

    executor = new TransactionExecutor(
      { maxRetries: 2, gasBumpPercentage: 20 },
      nonceManager,
      gasPriceManager,
      strategyRouter,
      balanceMonitor
    );
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should execute EVM funding action and return txHash', async () => {
    const fakeSigner = new ethers.Wallet('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', mockProvider);

    sinon.stub(strategyRouter, 'execute').resolves({
      success: true,
      txHash: '0xSUCCESSFUL_TX_HASH',
      gasUsed: 21000n,
    });

    const action: FundingAction = {
      chain: 'ethereum',
      protocol: 'ethereum',
      recipient: '0x1111111111111111111111111111111111111111',
      currentBalance: 0n,
      formattedCurrentBalance: '0',
      minThreshold: ethers.parseEther('0.5'),
      formattedMinThreshold: '0.5',
      desiredBalance: ethers.parseEther('1.0'),
      formattedDesiredBalance: '1.0',
      requiredFunding: ethers.parseEther('1.0'),
      formattedRequiredFunding: '1.0',
      funderAddress: fakeSigner.address,
      funderBalance: ethers.parseEther('50.0'),
      formattedFunderBalance: '50.0',
      strategy: 'direct',
      status: 'PENDING',
      decimals: 18,
      symbol: 'ETH',
    };

    const result = await executor.executeAction(
      action,
      { protocol: 'ethereum', rpcUrl: 'http://localhost:8545', recipients: [] },
      { type: 'privateKey', key: '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }
    );

    expect(result.success).to.be.true;
    expect(result.txHash).to.equal('0xSUCCESSFUL_TX_HASH');
  });

  it('should retry with bumped gas price when transaction fails', async () => {
    const executeStub = sinon.stub(strategyRouter, 'execute');
    // First attempt fails, second attempt succeeds
    executeStub.onFirstCall().resolves({ success: false, error: 'transaction underpriced' });
    executeStub.onSecondCall().resolves({ success: true, txHash: '0xBUMPED_TX_HASH' });

    const action: FundingAction = {
      chain: 'ethereum',
      protocol: 'ethereum',
      recipient: '0x1111111111111111111111111111111111111111',
      currentBalance: 0n,
      formattedCurrentBalance: '0',
      minThreshold: ethers.parseEther('0.5'),
      formattedMinThreshold: '0.5',
      desiredBalance: ethers.parseEther('1.0'),
      formattedDesiredBalance: '1.0',
      requiredFunding: ethers.parseEther('1.0'),
      formattedRequiredFunding: '1.0',
      funderAddress: '0x123',
      funderBalance: ethers.parseEther('50.0'),
      formattedFunderBalance: '50.0',
      strategy: 'direct',
      status: 'PENDING',
      decimals: 18,
      symbol: 'ETH',
    };

    const result = await executor.executeAction(
      action,
      { protocol: 'ethereum', rpcUrl: 'http://localhost:8545', recipients: [] },
      { type: 'privateKey', key: '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }
    );

    expect(result.success).to.be.true;
    expect(result.txHash).to.equal('0xBUMPED_TX_HASH');
    expect(executeStub.calledTwice).to.be.true;
  });

  it('should isolate failures across multi-chain batch executions', async () => {
    sinon.stub(executor, 'executeAction').callsFake(async (action) => {
      if (action.chain === 'broken_chain') {
        return { success: false, error: 'RPC unreachable' };
      }
      return { success: true, txHash: `0xHASH_${action.chain}` };
    });

    const actions: FundingAction[] = [
      {
        chain: 'ethereum',
        protocol: 'ethereum',
        recipient: '0xEthRec',
        currentBalance: 0n,
        formattedCurrentBalance: '0',
        minThreshold: 10n,
        formattedMinThreshold: '10',
        desiredBalance: 20n,
        formattedDesiredBalance: '20',
        requiredFunding: 20n,
        formattedRequiredFunding: '20',
        funderAddress: '0xFunder',
        funderBalance: 100n,
        formattedFunderBalance: '100',
        strategy: 'direct',
        status: 'PENDING',
        decimals: 18,
        symbol: 'ETH',
      },
      {
        chain: 'broken_chain',
        protocol: 'ethereum',
        recipient: '0xBrokenRec',
        currentBalance: 0n,
        formattedCurrentBalance: '0',
        minThreshold: 10n,
        formattedMinThreshold: '10',
        desiredBalance: 20n,
        formattedDesiredBalance: '20',
        requiredFunding: 20n,
        formattedRequiredFunding: '20',
        funderAddress: '0xFunder',
        funderBalance: 100n,
        formattedFunderBalance: '100',
        strategy: 'direct',
        status: 'PENDING',
        decimals: 18,
        symbol: 'ETH',
      },
    ];

    const config: KeyfunderConfig = {
      funder: { type: 'privateKey', key: '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' },
      chains: {
        ethereum: { protocol: 'ethereum', recipients: [{ address: '0xEthRec' }] },
        broken_chain: { protocol: 'ethereum', recipients: [{ address: '0xBrokenRec' }] },
      },
    };

    const executed = await executor.executeAll(actions, config);
    const ethAction = executed.find((a) => a.chain === 'ethereum');
    const brokenAction = executed.find((a) => a.chain === 'broken_chain');

    expect(ethAction?.status).to.equal('EXECUTED');
    expect(ethAction?.txHash).to.equal('0xHASH_ethereum');

    expect(brokenAction?.status).to.equal('FAILED');
    expect(brokenAction?.error).to.include('RPC unreachable');
  });
});
