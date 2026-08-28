import { expect } from 'chai';
import sinon from 'sinon';
import { ethers } from 'ethers';

import { MultiProtocolBalanceMonitor } from '../src/core/MultiProtocolBalanceMonitor';
import { PolicyEvaluator } from '../src/core/PolicyEvaluator';
import { DirectNativeStrategy } from '../src/strategies/DirectNativeStrategy';
import { WarpRouteStrategy } from '../src/strategies/WarpRouteStrategy';
import { RollupBridgeStrategy } from '../src/strategies/RollupBridgeStrategy';
import { NonceManager } from '../src/execution/NonceManager';
import { GasPriceManager } from '../src/execution/GasPriceManager';
import { TransactionExecutor } from '../src/execution/TransactionExecutor';
import { KeyfunderMetrics } from '../src/metrics/metrics';
import { formatBalancesTable } from '../src/cli/index';
import {
  ChainFundingConfig,
  FunderConfig,
  FundingAction,
  KeyfunderConfig,
  StrategyExecutionContext,
} from '../src/types';

describe('Tier 3: Cross-Feature Combinations (TypeScript Keyfunder: C1 - C7)', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('C1 (F1 + F2): BalanceMonitor feeds PolicyEvaluator across heterogeneous chains', async () => {
    const monitor = new MultiProtocolBalanceMonitor();
    const evaluator = new PolicyEvaluator();

    const mockEvm = {
      getBalance: sinon.stub().callsFake((addr: string) => {
        if (addr.toLowerCase() === '0xrec1'.toLowerCase()) return Promise.resolve(ethers.parseEther('0.2'));
        return Promise.resolve(ethers.parseEther('50.0'));
      }),
    };
    const mockSol = {
      getBalance: sinon.stub().callsFake((pubkey: any) => {
        if (pubkey.toString().includes('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin')) {
          return Promise.resolve(500_000_000); // 0.5 SOL
        }
        return Promise.resolve(50_000_000_000); // 50 SOL funder
      }),
    };
    const mockCosmos = {
      getBalance: sinon.stub().callsFake((addr: string) => {
        if (addr.includes('cosmos1hsk6jryyqjfhp5dhc55tc9jtckygx0e86eh6cx')) {
          return Promise.resolve({ denom: 'uatom', amount: '1000000' }); // 1 ATOM
        }
        return Promise.resolve({ denom: 'uatom', amount: '50000000' }); // 50 ATOM funder
      }),
    };

    monitor.setEvmProvider('http://evm.local', mockEvm as any);
    monitor.setSolanaConnection('http://sol.local', mockSol as any);
    monitor.setCosmosClient('http://cosmos.local', mockCosmos as any);

    const config: KeyfunderConfig = {
      funder: {
        type: 'privateKey',
        key: '0x0123456789012345678901234567890123456789012345678901234567890123',
      },
      chains: {
        ethereum: {
          protocol: 'ethereum',
          rpcUrl: 'http://evm.local',
          recipients: [{ address: '0xRec1', minBalance: '0.5', desiredBalance: '2.0' }],
        },
        solana: {
          protocol: 'sealevel',
          rpcUrl: 'http://sol.local',
          recipients: [{ address: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', minBalance: '1.0', desiredBalance: '3.0' }],
        },
        cosmoshub: {
          protocol: 'cosmos',
          rpcUrl: 'http://cosmos.local',
          strategyConfig: { type: 'direct', denom: 'uatom' },
          recipients: [{ address: 'cosmos1hsk6jryyqjfhp5dhc55tc9jtckygx0e86eh6cx', minBalance: '2.0', desiredBalance: '5.0' }],
        },
      },
    };

    const funderAddresses = {
      ethereum: '0x1234567890123456789012345678901234567890',
      solana: 'FunderPubkey1111111111111111111111111111111',
      cosmoshub: 'cosmos1funder12345678901234567890',
    };

    const reports = await monitor.getAllBalances(config, funderAddresses);
    const actions = evaluator.evaluateAll(config, reports);

    expect(actions).to.have.lengthOf(3);
    expect(actions[0].status).to.equal('PENDING');
    expect(actions[0].requiredFunding).to.equal(ethers.parseEther('1.8'));
    expect(actions[1].status).to.equal('PENDING');
    expect(actions[1].requiredFunding).to.equal(2_500_000_000n); // 2.5 SOL deficit
    expect(actions[2].status).to.equal('PENDING');
    expect(actions[2].requiredFunding).to.equal(4_000_000n); // 4 ATOM deficit
  });

  it('C2 (F2 + F3): PolicyEvaluator generates action executed via DirectNativeStrategy', async () => {
    const evaluator = new PolicyEvaluator();
    const strategy = new DirectNativeStrategy();

    const chainConfig: ChainFundingConfig = {
      protocol: 'ethereum',
      recipients: [{ address: '0x1111111111111111111111111111111111111111', minBalance: '1.0', desiredBalance: '4.0' }],
    };

    const report = {
      chain: 'ethereum',
      protocol: 'ethereum' as const,
      funderAddress: '0xFunder',
      funderBalance: ethers.parseEther('20.0'),
      formattedFunderBalance: '20.0',
      recipientBalances: [
        {
          recipient: '0x1111111111111111111111111111111111111111',
          balance: ethers.parseEther('0.5'),
          formattedBalance: '0.5',
          minBalance: ethers.parseEther('1.0'),
          formattedMinBalance: '1.0',
          desiredBalance: ethers.parseEther('4.0'),
          formattedDesiredBalance: '4.0',
          needsFunding: true,
          deficit: ethers.parseEther('3.5'),
          formattedDeficit: '3.5',
        },
      ],
    };

    const actions = evaluator.evaluateChain('ethereum', chainConfig, report);
    expect(actions[0].status).to.equal('PENDING');

    const mockSigner = {
      sendTransaction: sinon.stub().resolves({
        hash: '0xCOMBINED_DIRECT_TX',
        wait: sinon.stub().resolves({ gasUsed: 21000n }),
      }),
    };

    const context: StrategyExecutionContext = {
      chainConfig,
      funderConfig: { type: 'privateKey' },
    };

    const result = await strategy.execute(actions[0], context, { signer: mockSigner });
    expect(result.success).to.be.true;
    expect(result.txHash).to.equal('0xCOMBINED_DIRECT_TX');
    expect(mockSigner.sendTransaction.firstCall.args[0].value).to.equal(ethers.parseEther('3.5'));
  });

  it('C3 (F2 + F4): PolicyEvaluator routes token deficit to WarpRouteStrategy', async () => {
    const evaluator = new PolicyEvaluator();
    const strategy = new WarpRouteStrategy();

    const chainConfig: ChainFundingConfig = {
      protocol: 'ethereum',
      strategy: 'warpRoute',
      strategyConfig: {
        type: 'warpRoute',
        warpRouteAddress: '0xWarpRouteContract12345678901234567890',
        destinationDomain: 3000,
      },
      recipients: [{ address: '0x2222222222222222222222222222222222222222', minBalance: '5.0', desiredBalance: '20.0' }],
    };

    const report = {
      chain: 'ethereum',
      protocol: 'ethereum' as const,
      funderAddress: '0xFunder',
      funderBalance: ethers.parseEther('50.0'),
      formattedFunderBalance: '50.0',
      recipientBalances: [
        {
          recipient: '0x2222222222222222222222222222222222222222',
          balance: ethers.parseEther('2.0'),
          formattedBalance: '2.0',
          minBalance: ethers.parseEther('5.0'),
          formattedMinBalance: '5.0',
          desiredBalance: ethers.parseEther('20.0'),
          formattedDesiredBalance: '20.0',
          needsFunding: true,
          deficit: ethers.parseEther('18.0'),
          formattedDeficit: '18.0',
        },
      ],
    };

    const actions = evaluator.evaluateChain('ethereum', chainConfig, report);
    expect(actions[0].strategy).to.equal('warpRoute');
    expect(actions[0].requiredFunding).to.equal(ethers.parseEther('18.0'));

    const mockWarpContract = {
      quoteGasPayment: sinon.stub().resolves(ethers.parseEther('0.01')),
      transferRemote: sinon.stub().resolves({
        hash: '0xWARP_COMBINED_TX',
        wait: sinon.stub().resolves({ gasUsed: 150000n }),
      }),
    };
    sinon.stub(strategy, 'getContract').callsFake(() => mockWarpContract as any);

    const context: StrategyExecutionContext = {
      chainConfig,
      funderConfig: { type: 'privateKey' },
    };

    const result = await strategy.execute(actions[0], context, { signer: {} });
    expect(result.success).to.be.true;
    expect(mockWarpContract.transferRemote.firstCall.args[3].value).to.equal(ethers.parseEther('18.01'));
  });

  it('C4 (F2 + F5): PolicyEvaluator routes deficit to RollupBridgeStrategy for L1->L2 top-up', async () => {
    const evaluator = new PolicyEvaluator();
    const strategy = new RollupBridgeStrategy();

    const chainConfig: ChainFundingConfig = {
      protocol: 'ethereum',
      strategy: 'opStackBridge',
      strategyConfig: {
        type: 'opStackBridge',
        portalAddress: '0xOptimismPortal12345678901234567890123456',
        l2GasLimit: 200000,
      },
      recipients: [{ address: '0x3333333333333333333333333333333333333333', minBalance: '0.1', desiredBalance: '1.0' }],
    };

    const report = {
      chain: 'optimism',
      protocol: 'ethereum' as const,
      funderAddress: '0xFunder',
      funderBalance: ethers.parseEther('10.0'),
      formattedFunderBalance: '10.0',
      recipientBalances: [
        {
          recipient: '0x3333333333333333333333333333333333333333',
          balance: ethers.parseEther('0.02'),
          formattedBalance: '0.02',
          minBalance: ethers.parseEther('0.1'),
          formattedMinBalance: '0.1',
          desiredBalance: ethers.parseEther('1.0'),
          formattedDesiredBalance: '1.0',
          needsFunding: true,
          deficit: ethers.parseEther('0.98'),
          formattedDeficit: '0.98',
        },
      ],
    };

    const actions = evaluator.evaluateChain('optimism', chainConfig, report);
    expect(actions[0].strategy).to.equal('opStackBridge');

    const mockPortal = {
      depositTransaction: sinon.stub().resolves({
        hash: '0xOP_COMBINED_TX',
        wait: sinon.stub().resolves({ gasUsed: 95000n }),
      }),
    };
    sinon.stub(strategy, 'getContract').callsFake(() => mockPortal as any);

    const context: StrategyExecutionContext = {
      chainConfig,
      funderConfig: { type: 'privateKey' },
    };

    const result = await strategy.execute(actions[0], context, { signer: {} });
    expect(result.success).to.be.true;
    expect(mockPortal.depositTransaction.firstCall.args[1]).to.equal(ethers.parseEther('0.98'));
  });

  it('C5 (F3 + F6): DirectNativeStrategy coordinates with NonceManager and GasPriceManager', async () => {
    const nonceManager = new NonceManager();
    const gasPriceManager = new GasPriceManager(1.2);
    const strategy = new DirectNativeStrategy();

    const mockProvider = {
      getTransactionCount: sinon.stub().resolves(42),
      getFeeData: sinon.stub().resolves({
        maxFeePerGas: ethers.parseUnits('30', 'gwei'),
        maxPriorityFeePerGas: ethers.parseUnits('2', 'gwei'),
        gasPrice: null,
      }),
    };

    const nonce = await nonceManager.getAndIncrementNonce('ethereum', '0xFunder', mockProvider as any);
    const feeEstimates = await gasPriceManager.getFeeEstimates(mockProvider as any, 1.2);

    expect(nonce).to.equal(42);
    expect(feeEstimates.maxFeePerGas).to.equal(ethers.parseUnits('36', 'gwei'));

    const mockSigner = {
      sendTransaction: sinon.stub().resolves({
        hash: '0xMANAGED_TX_123',
        wait: sinon.stub().resolves({ gasUsed: 21000n }),
      }),
    };

    const action: FundingAction = {
      chain: 'ethereum',
      protocol: 'ethereum',
      recipient: '0x1111111111111111111111111111111111111111',
      currentBalance: 0n,
      formattedCurrentBalance: '0.0',
      minThreshold: 100n,
      formattedMinThreshold: '100',
      desiredBalance: 1000n,
      formattedDesiredBalance: '1000',
      requiredFunding: ethers.parseEther('1.0'),
      formattedRequiredFunding: '1.0',
      funderAddress: '0xFunder',
      funderBalance: ethers.parseEther('10.0'),
      formattedFunderBalance: '10.0',
      strategy: 'direct',
      status: 'PENDING',
      decimals: 18,
      symbol: 'ETH',
    };

    const gasOverrides = {
      nonce,
      maxFeePerGas: feeEstimates.maxFeePerGas,
      maxPriorityFeePerGas: feeEstimates.maxPriorityFeePerGas,
    };

    const context: StrategyExecutionContext = {
      chainConfig: { protocol: 'ethereum', recipients: [] },
      funderConfig: { type: 'privateKey' },
    };

    const result = await strategy.execute(action, context, { signer: mockSigner, gasOverrides });
    expect(result.success).to.be.true;
    expect(mockSigner.sendTransaction.firstCall.args[0].nonce).to.equal(42);
    expect(mockSigner.sendTransaction.firstCall.args[0].maxFeePerGas).to.equal(ethers.parseUnits('36', 'gwei'));
  });

  it('C6 (F6 + F7): TransactionExecutor updates nonces and exports metrics', async () => {
    const metrics = new KeyfunderMetrics();
    const executor = new TransactionExecutor({ dryRun: true });

    const actions: FundingAction[] = [
      {
        chain: 'ethereum',
        protocol: 'ethereum',
        recipient: '0x1111111111111111111111111111111111111111',
        currentBalance: 0n,
        formattedCurrentBalance: '0.0',
        minThreshold: 100n,
        formattedMinThreshold: '100',
        desiredBalance: 1000n,
        formattedDesiredBalance: '1000',
        requiredFunding: ethers.parseEther('2.0'),
        formattedRequiredFunding: '2.0',
        funderAddress: '0xFunder',
        funderBalance: ethers.parseEther('10.0'),
        formattedFunderBalance: '10.0',
        strategy: 'direct',
        status: 'PENDING',
        decimals: 18,
        symbol: 'ETH',
      },
    ];

    const config: KeyfunderConfig = {
      funder: { type: 'privateKey' },
      chains: {
        ethereum: { protocol: 'ethereum', recipients: [] },
      },
    };

    const executed = await executor.executeAll(actions, config);
    expect(executed[0].status).to.equal('EXECUTED');

    metrics.recordActions(executed);
    expect(metrics.fundingActionsTotal).to.exist;
  });

  it('C7 (F1 + F7): Balance monitor queries format directly into CLI balance table', async () => {
    const monitor = new MultiProtocolBalanceMonitor();

    const mockEvm = { getBalance: sinon.stub().resolves(ethers.parseEther('0.1')) };
    monitor.setEvmProvider('http://evm.local', mockEvm as any);

    const config: KeyfunderConfig = {
      funder: { type: 'privateKey' },
      chains: {
        ethereum: {
          protocol: 'ethereum',
          rpcUrl: 'http://evm.local',
          recipients: [{ name: 'relayer-alpha', address: '0x1111111111111111111111111111111111111111', minBalance: '0.5', desiredBalance: '2.0' }],
        },
      },
    };

    const reports = await monitor.getAllBalances(config);
    const tableStr = formatBalancesTable(reports);

    expect(tableStr).to.include('ethereum');
    expect(tableStr).to.include('relayer-alpha');
    expect(tableStr).to.include('0.1');
    expect(tableStr).to.include('YES');
  });
});
