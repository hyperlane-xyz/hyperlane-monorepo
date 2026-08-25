import { expect } from 'chai';
import sinon from 'sinon';
import { ethers } from 'ethers';
import http from 'http';

import { MultiProtocolBalanceMonitor } from '../src/core/MultiProtocolBalanceMonitor';
import { PolicyEvaluator } from '../src/core/PolicyEvaluator';
import { DirectNativeStrategy } from '../src/strategies/DirectNativeStrategy';
import { WarpRouteStrategy } from '../src/strategies/WarpRouteStrategy';
import { RollupBridgeStrategy } from '../src/strategies/RollupBridgeStrategy';
import { NonceManager } from '../src/execution/NonceManager';
import { GasPriceManager } from '../src/execution/GasPriceManager';
import { TransactionExecutor } from '../src/execution/TransactionExecutor';
import { KeyfunderMetrics } from '../src/metrics/metrics';
import { formatActionsTable, formatBalancesTable } from '../src/cli/index';
import {
  ChainBalanceReport,
  ChainFundingConfig,
  FunderConfig,
  FundingAction,
  FundingPolicy,
  StrategyExecutionContext,
} from '../src/types';

describe('Tier 2: Boundary & Corner Cases (TypeScript Keyfunder: F1 - F7)', () => {
  afterEach(() => {
    sinon.restore();
  });

  // ==========================================
  // Feature 1 Boundaries (5 tests)
  // ==========================================
  describe('F1 Boundaries: MultiProtocolBalanceMonitor', () => {
    let monitor: MultiProtocolBalanceMonitor;

    beforeEach(() => {
      monitor = new MultiProtocolBalanceMonitor({ retryCount: 1, timeoutMs: 1000 });
    });

    it('F1.B1: should return 0n when balance is zero', async () => {
      const mockProvider = {
        getBalance: sinon.stub().resolves(0n),
      };
      monitor.setEvmProvider('http://127.0.0.1:8545', mockProvider as any);

      const chainConfig: ChainFundingConfig = {
        protocol: 'ethereum',
        rpcUrl: 'http://127.0.0.1:8545',
        recipients: [],
      };

      const balance = await monitor.getNativeBalance(chainConfig, '0x1111111111111111111111111111111111111111');
      expect(balance).to.equal(0n);
    });

    it('F1.B2: should switch to fallback RPC when primary RPC fails', async () => {
      const mockPrimaryProvider = {
        getBalance: sinon.stub().rejects(new Error('Connection refused')),
      };
      const mockFallbackProvider = {
        getBalance: sinon.stub().resolves(ethers.parseEther('5.0')),
      };

      monitor.setEvmProvider('http://primary-rpc.local', mockPrimaryProvider as any);
      monitor.setEvmProvider('http://fallback-rpc.local', mockFallbackProvider as any);

      const chainConfig: ChainFundingConfig = {
        protocol: 'ethereum',
        rpcUrl: 'http://primary-rpc.local',
        fallbackRpcUrls: ['http://fallback-rpc.local'],
        recipients: [],
      };

      const balance = await monitor.getNativeBalance(chainConfig, '0x1111111111111111111111111111111111111111');
      expect(balance).to.equal(ethers.parseEther('5.0'));
      expect(mockFallbackProvider.getBalance.calledOnce).to.be.true;
    });

    it('F1.B3: should throw error when all primary and fallback RPCs fail', async () => {
      const mockPrimaryProvider = {
        getBalance: sinon.stub().rejects(new Error('Primary RPC dead')),
      };
      const mockFallbackProvider = {
        getBalance: sinon.stub().rejects(new Error('Fallback RPC dead')),
      };

      monitor.setEvmProvider('http://primary-rpc.local', mockPrimaryProvider as any);
      monitor.setEvmProvider('http://fallback-rpc.local', mockFallbackProvider as any);

      const chainConfig: ChainFundingConfig = {
        protocol: 'ethereum',
        rpcUrl: 'http://primary-rpc.local',
        fallbackRpcUrls: ['http://fallback-rpc.local'],
        recipients: [],
      };

      try {
        await monitor.getNativeBalance(chainConfig, '0x1111111111111111111111111111111111111111');
        expect.fail('Should have thrown an error');
      } catch (err: any) {
        expect(err.message).to.exist;
      }
    });

    it('F1.B4: should throw error on invalid Solana public key format', async () => {
      const chainConfig: ChainFundingConfig = {
        protocol: 'sealevel',
        rpcUrl: 'http://127.0.0.1:8899',
        recipients: [],
      };

      try {
        await monitor.getNativeBalance(chainConfig, 'invalid-non-base58-key!!!');
        expect.fail('Should have thrown on invalid address format');
      } catch (err: any) {
        expect(err.message).to.exist;
      }
    });

    it('F1.B5: should fall back gracefully to default uatom denom when denom is unspecified in Cosmos', async () => {
      const mockClient = {
        getBalance: sinon.stub().resolves({ denom: 'uatom', amount: '123456' }),
      };
      monitor.setCosmosClient('http://127.0.0.1:26657', mockClient as any);

      const chainConfig: ChainFundingConfig = {
        protocol: 'cosmos',
        rpcUrl: 'http://127.0.0.1:26657',
        recipients: [],
      };

      const balance = await monitor.getNativeBalance(chainConfig, 'cosmos1hsk6jryyqjfhp5dhc55tc9jtckygx0e86eh6cx');
      expect(balance).to.equal(123456n);
      expect(mockClient.getBalance.calledWith('cosmos1hsk6jryyqjfhp5dhc55tc9jtckygx0e86eh6cx', 'uatom')).to.be.true;
    });
  });

  // ==========================================
  // Feature 2 Boundaries (5 tests)
  // ==========================================
  describe('F2 Boundaries: FundingPolicyEngine', () => {
    let evaluator: PolicyEvaluator;

    beforeEach(() => {
      evaluator = new PolicyEvaluator();
    });

    it('F2.B1: Exact threshold boundary: currentBalance == minBalance results in SKIPPED', () => {
      const chainConfig: ChainFundingConfig = {
        protocol: 'ethereum',
        recipients: [{ address: '0xRec1', minBalance: '1.0', desiredBalance: '3.0' }],
      };
      const report: ChainBalanceReport = {
        chain: 'ethereum',
        protocol: 'ethereum',
        funderAddress: '0xFunder',
        funderBalance: ethers.parseEther('10.0'),
        formattedFunderBalance: '10.0',
        recipientBalances: [
          {
            recipient: '0xRec1',
            balance: ethers.parseEther('1.0'), // Exactly equal to minBalance
            formattedBalance: '1.0',
            minBalance: ethers.parseEther('1.0'),
            formattedMinBalance: '1.0',
            desiredBalance: ethers.parseEther('3.0'),
            formattedDesiredBalance: '3.0',
            needsFunding: false,
            deficit: 0n,
            formattedDeficit: '0.0',
          },
        ],
      };

      const actions = evaluator.evaluateChain('ethereum', chainConfig, report);
      expect(actions[0].status).to.equal('SKIPPED');
      expect(actions[0].requiredFunding).to.equal(0n);
    });

    it('F2.B2: Exact threshold boundary: currentBalance == minBalance - 1n results in PENDING', () => {
      const chainConfig: ChainFundingConfig = {
        protocol: 'ethereum',
        recipients: [{ address: '0xRec1', minBalance: '1.0', desiredBalance: '3.0' }],
      };
      const report: ChainBalanceReport = {
        chain: 'ethereum',
        protocol: 'ethereum',
        funderAddress: '0xFunder',
        funderBalance: ethers.parseEther('10.0'),
        formattedFunderBalance: '10.0',
        recipientBalances: [
          {
            recipient: '0xRec1',
            balance: ethers.parseEther('1.0') - 1n, // Exactly 1 wei below minBalance
            formattedBalance: '0.999999999999999999',
            minBalance: ethers.parseEther('1.0'),
            formattedMinBalance: '1.0',
            desiredBalance: ethers.parseEther('3.0'),
            formattedDesiredBalance: '3.0',
            needsFunding: true,
            deficit: ethers.parseEther('2.0') + 1n,
            formattedDeficit: '2.000000000000000001',
          },
        ],
      };

      const actions = evaluator.evaluateChain('ethereum', chainConfig, report);
      expect(actions[0].status).to.equal('PENDING');
      expect(actions[0].requiredFunding).to.equal(ethers.parseEther('2.0') + 1n);
    });

    it('F2.B3: Funder balance exactly equal to minReserve produces SKIPPED action', () => {
      const chainConfig: ChainFundingConfig = {
        protocol: 'ethereum',
        funderMinReserve: '5.0',
        recipients: [{ address: '0xRec1', minBalance: '1.0', desiredBalance: '3.0' }],
      };
      const report: ChainBalanceReport = {
        chain: 'ethereum',
        protocol: 'ethereum',
        funderAddress: '0xFunder',
        funderBalance: ethers.parseEther('5.0'), // Exactly at floor
        formattedFunderBalance: '5.0',
        recipientBalances: [
          {
            recipient: '0xRec1',
            balance: 0n,
            formattedBalance: '0.0',
            minBalance: ethers.parseEther('1.0'),
            formattedMinBalance: '1.0',
            desiredBalance: ethers.parseEther('3.0'),
            formattedDesiredBalance: '3.0',
            needsFunding: true,
            deficit: ethers.parseEther('3.0'),
            formattedDeficit: '3.0',
          },
        ],
      };

      const actions = evaluator.evaluateChain('ethereum', chainConfig, report);
      expect(actions[0].status).to.equal('SKIPPED');
      expect(actions[0].skipReason).to.include('reserve floor');
    });

    it('F2.B4: Sequential multi-recipient reserve depletion: second recipient is skipped/capped', () => {
      const chainConfig: ChainFundingConfig = {
        protocol: 'ethereum',
        funderMinReserve: '2.0',
        recipients: [
          { address: '0xRec1', minBalance: '1.0', desiredBalance: '3.0' },
          { address: '0xRec2', minBalance: '1.0', desiredBalance: '3.0' },
        ],
      };
      // Funder has 4.0 ETH, minReserve is 2.0 ETH -> Available is 2.0 ETH
      // Recipient 1 needs 3.0 ETH -> Capped to 2.0 ETH
      // Recipient 2 needs 3.0 ETH -> Funder reserve now at 2.0 ETH floor -> Skipped!
      const report: ChainBalanceReport = {
        chain: 'ethereum',
        protocol: 'ethereum',
        funderAddress: '0xFunder',
        funderBalance: ethers.parseEther('4.0'),
        formattedFunderBalance: '4.0',
        recipientBalances: [
          {
            recipient: '0xRec1',
            balance: 0n,
            formattedBalance: '0.0',
            minBalance: ethers.parseEther('1.0'),
            formattedMinBalance: '1.0',
            desiredBalance: ethers.parseEther('3.0'),
            formattedDesiredBalance: '3.0',
            needsFunding: true,
            deficit: ethers.parseEther('3.0'),
            formattedDeficit: '3.0',
          },
          {
            recipient: '0xRec2',
            balance: 0n,
            formattedBalance: '0.0',
            minBalance: ethers.parseEther('1.0'),
            formattedMinBalance: '1.0',
            desiredBalance: ethers.parseEther('3.0'),
            formattedDesiredBalance: '3.0',
            needsFunding: true,
            deficit: ethers.parseEther('3.0'),
            formattedDeficit: '3.0',
          },
        ],
      };

      const actions = evaluator.evaluateChain('ethereum', chainConfig, report);
      expect(actions[0].status).to.equal('PENDING');
      expect(actions[0].requiredFunding).to.equal(ethers.parseEther('2.0'));
      expect(actions[1].status).to.equal('SKIPPED');
    });

    it('F2.B5: Zero desiredBalance and zero minBalance handles cleanly without errors', () => {
      const chainConfig: ChainFundingConfig = {
        protocol: 'ethereum',
        recipients: [{ address: '0xRec1', minBalance: '0', desiredBalance: '0' }],
      };
      const report: ChainBalanceReport = {
        chain: 'ethereum',
        protocol: 'ethereum',
        funderAddress: '0xFunder',
        funderBalance: ethers.parseEther('10.0'),
        formattedFunderBalance: '10.0',
        recipientBalances: [
          {
            recipient: '0xRec1',
            balance: 0n,
            formattedBalance: '0.0',
            minBalance: 0n,
            formattedMinBalance: '0.0',
            desiredBalance: 0n,
            formattedDesiredBalance: '0.0',
            needsFunding: false,
            deficit: 0n,
            formattedDeficit: '0.0',
          },
        ],
      };

      const actions = evaluator.evaluateChain('ethereum', chainConfig, report);
      expect(actions[0].status).to.equal('SKIPPED');
      expect(actions[0].requiredFunding).to.equal(0n);
    });
  });

  // ==========================================
  // Feature 3 Boundaries (5 tests)
  // ==========================================
  describe('F3 Boundaries: DirectNativeStrategy', () => {
    let strategy: DirectNativeStrategy;

    beforeEach(() => {
      strategy = new DirectNativeStrategy();
    });

    it('F3.B1: EVM direct transfer error handles insufficient funds gracefully', async () => {
      const mockSigner = {
        sendTransaction: sinon.stub().rejects(new Error('insufficient funds for gas * price + value')),
      };

      const action: FundingAction = {
        chain: 'ethereum',
        protocol: 'ethereum',
        recipient: '0x2222222222222222222222222222222222222222',
        currentBalance: 0n,
        formattedCurrentBalance: '0.0',
        minThreshold: 100n,
        formattedMinThreshold: '100',
        desiredBalance: 1000n,
        formattedDesiredBalance: '1000',
        requiredFunding: ethers.parseEther('100.0'),
        formattedRequiredFunding: '100.0',
        funderAddress: '0xFunder',
        funderBalance: ethers.parseEther('0.1'),
        formattedFunderBalance: '0.1',
        strategy: 'direct',
        status: 'PENDING',
        decimals: 18,
        symbol: 'ETH',
      };

      const context: StrategyExecutionContext = {
        chainConfig: { protocol: 'ethereum', recipients: [] },
        funderConfig: { type: 'privateKey' },
      };

      const result = await strategy.execute(action, context, { signer: mockSigner });
      expect(result.success).to.be.false;
      expect(result.error).to.include('insufficient funds');
    });

    it('F3.B2: EVM direct transfer with null or undefined signerContext returns error', async () => {
      const action: FundingAction = {
        chain: 'ethereum',
        protocol: 'ethereum',
        recipient: '0x2222222222222222222222222222222222222222',
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

      const context: StrategyExecutionContext = {
        chainConfig: { protocol: 'ethereum', recipients: [] },
        funderConfig: { type: 'privateKey' },
      };

      const result = await strategy.execute(action, context, null);
      expect(result.success).to.be.false;
      expect(result.error).to.include('Signer is required');
    });

    it('F3.B3: Solana direct transfer without keypair in signerContext returns error', async () => {
      const action: FundingAction = {
        chain: 'solana',
        protocol: 'sealevel',
        recipient: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
        currentBalance: 0n,
        formattedCurrentBalance: '0.0',
        minThreshold: 100n,
        formattedMinThreshold: '100',
        desiredBalance: 1000n,
        formattedDesiredBalance: '1000',
        requiredFunding: 1_000_000_000n,
        formattedRequiredFunding: '1.0',
        funderAddress: 'FunderPubkey',
        funderBalance: 10_000_000_000n,
        formattedFunderBalance: '10.0',
        strategy: 'direct',
        status: 'PENDING',
        decimals: 9,
        symbol: 'SOL',
      };

      const context: StrategyExecutionContext = {
        chainConfig: { protocol: 'sealevel', recipients: [] },
        funderConfig: { type: 'privateKey' },
      };

      const result = await strategy.execute(action, context, {});
      expect(result.success).to.be.false;
      expect(result.error).to.include('Keypair is required');
    });

    it('F3.B4: Cosmos direct transfer without stargateClient returns error', async () => {
      const action: FundingAction = {
        chain: 'cosmoshub',
        protocol: 'cosmos',
        recipient: 'cosmos1hsk6jryyqjfhp5dhc55tc9jtckygx0e86eh6cx',
        currentBalance: 0n,
        formattedCurrentBalance: '0.0',
        minThreshold: 100n,
        formattedMinThreshold: '100',
        desiredBalance: 1000n,
        formattedDesiredBalance: '1000',
        requiredFunding: 2_000_000n,
        formattedRequiredFunding: '2.0',
        funderAddress: 'cosmos1funder',
        funderBalance: 20_000_000n,
        formattedFunderBalance: '20.0',
        strategy: 'direct',
        status: 'PENDING',
        decimals: 6,
        symbol: 'ATOM',
      };

      const context: StrategyExecutionContext = {
        chainConfig: { protocol: 'cosmos', recipients: [] },
        funderConfig: { type: 'privateKey' },
      };

      const result = await strategy.execute(action, context, { funderAddress: 'cosmos1funder' });
      expect(result.success).to.be.false;
      expect(result.error).to.include('SigningStargateClient is required');
    });

    it('F3.B5: Unsupported protocol type returns clean error', async () => {
      const action: FundingAction = {
        chain: 'unknown',
        protocol: 'unsupported' as any,
        recipient: '0x2222',
        currentBalance: 0n,
        formattedCurrentBalance: '0.0',
        minThreshold: 100n,
        formattedMinThreshold: '100',
        desiredBalance: 1000n,
        formattedDesiredBalance: '1000',
        requiredFunding: 1000n,
        formattedRequiredFunding: '1000',
        funderAddress: '0xFunder',
        funderBalance: 10000n,
        formattedFunderBalance: '10000',
        strategy: 'direct',
        status: 'PENDING',
        decimals: 18,
        symbol: 'UNKNOWN',
      };

      const context: StrategyExecutionContext = {
        chainConfig: { protocol: 'unsupported' as any, recipients: [] },
        funderConfig: { type: 'privateKey' },
      };

      const result = await strategy.execute(action, context, { signer: {} });
      expect(result.success).to.be.false;
      expect(result.error).to.include('Unsupported protocol');
    });
  });

  // ==========================================
  // Feature 4 Boundaries (5 tests)
  // ==========================================
  describe('F4 Boundaries: WarpRouteBridgeStrategy', () => {
    let strategy: WarpRouteStrategy;

    beforeEach(() => {
      strategy = new WarpRouteStrategy();
    });

    it('F4.B1: Warp Route contract quoteGasPayment failure falls back to 0 gasQuote', async () => {
      const mockSigner = {};
      const mockWarpContract = {
        quoteGasPayment: sinon.stub().rejects(new Error('quote unavailable')),
        transferRemote: sinon.stub().resolves({
          hash: '0xWARP_ZERO_QUOTE_TX',
          wait: sinon.stub().resolves({ gasUsed: 120000n }),
        }),
      };
      sinon.stub(strategy, 'getContract').callsFake(() => mockWarpContract as any);

      const action: FundingAction = {
        chain: 'ethereum',
        protocol: 'ethereum',
        recipient: '0x2222222222222222222222222222222222222222',
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
        strategy: 'warpRoute',
        status: 'PENDING',
        decimals: 18,
        symbol: 'ETH',
      };

      const context: StrategyExecutionContext = {
        chainConfig: {
          protocol: 'ethereum',
          recipients: [],
          strategyConfig: {
            type: 'warpRoute',
            warpRouteAddress: '0xWarpRouteAddr',
            destinationDomain: 2000,
          },
        },
        funderConfig: { type: 'privateKey' },
      };

      const result = await strategy.execute(action, context, { signer: mockSigner });
      expect(result.success).to.be.true;
      expect(mockWarpContract.transferRemote.firstCall.args[3].value).to.equal(ethers.parseEther('1.0'));
    });

    it('F4.B2: Warp Route ERC20 token transfer where allowance is sufficient skips approve', async () => {
      const mockSigner = {
        getAddress: sinon.stub().resolves('0xFunderAddr'),
      };
      const mockWarpContract = {
        quoteGasPayment: sinon.stub().resolves(0n),
        transferRemote: sinon.stub().resolves({
          hash: '0xWARP_NO_APPROVE_TX',
          wait: sinon.stub().resolves({ gasUsed: 100000n }),
        }),
      };
      const mockErc20 = {
        allowance: sinon.stub().resolves(ethers.parseUnits('10000', 6)), // Sufficient allowance
        approve: sinon.stub().resolves({}),
      };

      sinon.stub(strategy, 'getContract').callsFake((addr: string) => {
        if (addr === '0xTokenAddress') return mockErc20 as any;
        return mockWarpContract as any;
      });

      const action: FundingAction = {
        chain: 'ethereum',
        protocol: 'ethereum',
        recipient: '0x2222222222222222222222222222222222222222',
        currentBalance: 0n,
        formattedCurrentBalance: '0.0',
        minThreshold: 100n,
        formattedMinThreshold: '100',
        desiredBalance: 1000n,
        formattedDesiredBalance: '1000',
        requiredFunding: ethers.parseUnits('100', 6),
        formattedRequiredFunding: '100.0',
        funderAddress: '0xFunder',
        funderBalance: ethers.parseUnits('1000', 6),
        formattedFunderBalance: '1000.0',
        strategy: 'warpRoute',
        status: 'PENDING',
        decimals: 6,
        symbol: 'USDC',
        tokenAddress: '0xTokenAddress',
      };

      const context: StrategyExecutionContext = {
        chainConfig: {
          protocol: 'ethereum',
          recipients: [],
          strategyConfig: {
            type: 'warpRoute',
            warpRouteAddress: '0xWarpRouteAddr',
            destinationDomain: 2000,
          },
        },
        funderConfig: { type: 'privateKey' },
      };

      const result = await strategy.execute(action, context, { signer: mockSigner });
      expect(result.success).to.be.true;
      expect(mockErc20.approve.called).to.be.false; // approve skipped
    });

    it('F4.B3: Warp Route ERC20 token transfer where approve fails returns failure result', async () => {
      const mockSigner = {
        getAddress: sinon.stub().resolves('0xFunderAddr'),
      };
      const mockErc20 = {
        allowance: sinon.stub().resolves(0n),
        approve: sinon.stub().rejects(new Error('ERC20: approve failed / user rejected')),
      };

      sinon.stub(strategy, 'getContract').callsFake((addr: string) => {
        if (addr === '0xTokenAddress') return mockErc20 as any;
        return {} as any;
      });

      const action: FundingAction = {
        chain: 'ethereum',
        protocol: 'ethereum',
        recipient: '0x2222222222222222222222222222222222222222',
        currentBalance: 0n,
        formattedCurrentBalance: '0.0',
        minThreshold: 100n,
        formattedMinThreshold: '100',
        desiredBalance: 1000n,
        formattedDesiredBalance: '1000',
        requiredFunding: ethers.parseUnits('100', 6),
        formattedRequiredFunding: '100.0',
        funderAddress: '0xFunder',
        funderBalance: ethers.parseUnits('1000', 6),
        formattedFunderBalance: '1000.0',
        strategy: 'warpRoute',
        status: 'PENDING',
        decimals: 6,
        symbol: 'USDC',
        tokenAddress: '0xTokenAddress',
      };

      const context: StrategyExecutionContext = {
        chainConfig: {
          protocol: 'ethereum',
          recipients: [],
          strategyConfig: {
            type: 'warpRoute',
            warpRouteAddress: '0xWarpRouteAddr',
            destinationDomain: 2000,
          },
        },
        funderConfig: { type: 'privateKey' },
      };

      const result = await strategy.execute(action, context, { signer: mockSigner });
      expect(result.success).to.be.false;
      expect(result.error).to.include('approve failed');
    });

    it('F4.B4: Warp Route converts zero EVM address to 32 zero bytes', () => {
      const zeroEvm = '0x0000000000000000000000000000000000000000';
      const b32 = strategy.addressToBytes32(zeroEvm, 'ethereum');
      expect(b32).to.equal('0x0000000000000000000000000000000000000000000000000000000000000000');
    });

    it('F4.B5: Warp Route handles already 32-byte hex addresses idempotently', () => {
      const hex32 = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      const b32 = strategy.addressToBytes32(hex32);
      expect(b32).to.equal(hex32);
    });
  });

  // ==========================================
  // Feature 5 Boundaries (5 tests)
  // ==========================================
  describe('F5 Boundaries: RollupBridgeStrategy', () => {
    let strategy: RollupBridgeStrategy;

    beforeEach(() => {
      strategy = new RollupBridgeStrategy();
    });

    it('F5.B1: OP Stack deposit with custom gas limit overrides default 200,000', async () => {
      const mockSigner = {};
      const mockPortal = {
        depositTransaction: sinon.stub().resolves({
          hash: '0xOP_CUSTOM_GAS_TX',
          wait: sinon.stub().resolves({ gasUsed: 100000n }),
        }),
      };
      sinon.stub(strategy, 'getContract').callsFake(() => mockPortal as any);

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
        requiredFunding: ethers.parseEther('0.5'),
        formattedRequiredFunding: '0.5',
        funderAddress: '0xFunder',
        funderBalance: ethers.parseEther('10.0'),
        formattedFunderBalance: '10.0',
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
            portalAddress: '0xPortalAddr',
            l2GasLimit: 750000,
          },
        },
        funderConfig: { type: 'privateKey' },
      };

      await strategy.execute(action, context, { signer: mockSigner });
      expect(mockPortal.depositTransaction.firstCall.args[2]).to.equal(750000);
    });

    it('F5.B2: Arbitrum createRetryableTicket failure in broadcast returns error result', async () => {
      const mockSigner = {
        getAddress: sinon.stub().resolves('0xSignerAddr'),
      };
      const mockInbox = {
        createRetryableTicket: sinon.stub().rejects(new Error('Inbox: execution reverted: MAX_SUBMISSION_COST_TOO_LOW')),
      };
      sinon.stub(strategy, 'getContract').callsFake(() => mockInbox as any);

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
        requiredFunding: ethers.parseEther('1.0'),
        formattedRequiredFunding: '1.0',
        funderAddress: '0xFunder',
        funderBalance: ethers.parseEther('10.0'),
        formattedFunderBalance: '10.0',
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
            inboxAddress: '0xInboxAddr',
          },
        },
        funderConfig: { type: 'privateKey' },
      };

      const result = await strategy.execute(action, context, { signer: mockSigner });
      expect(result.success).to.be.false;
      expect(result.error).to.include('MAX_SUBMISSION_COST_TOO_LOW');
    });

    it('F5.B3: OP Stack deposit transaction failure in receipt polling returns error result', async () => {
      const mockSigner = {};
      const mockPortal = {
        depositTransaction: sinon.stub().resolves({
          hash: '0xOP_FAIL_TX',
          wait: sinon.stub().rejects(new Error('Transaction reverted during on-chain execution')),
        }),
      };
      sinon.stub(strategy, 'getContract').callsFake(() => mockPortal as any);

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
        requiredFunding: ethers.parseEther('0.5'),
        formattedRequiredFunding: '0.5',
        funderAddress: '0xFunder',
        funderBalance: ethers.parseEther('10.0'),
        formattedFunderBalance: '10.0',
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
            portalAddress: '0xPortalAddr',
          },
        },
        funderConfig: { type: 'privateKey' },
      };

      const result = await strategy.execute(action, context, { signer: mockSigner });
      expect(result.success).to.be.false;
      expect(result.error).to.include('reverted');
    });

    it('F5.B4: Rollup bridge strategy with completely unknown strategy type and missing portal/inbox throws error', async () => {
      const action: FundingAction = {
        chain: 'unknown-rollup',
        protocol: 'ethereum',
        recipient: '0x1111',
        currentBalance: 0n,
        formattedCurrentBalance: '0.0',
        minThreshold: 100n,
        formattedMinThreshold: '100',
        desiredBalance: 1000n,
        formattedDesiredBalance: '1000',
        requiredFunding: ethers.parseEther('0.5'),
        formattedRequiredFunding: '0.5',
        funderAddress: '0xFunder',
        funderBalance: ethers.parseEther('10.0'),
        formattedFunderBalance: '10.0',
        strategy: 'unknownBridge',
        status: 'PENDING',
        decimals: 18,
        symbol: 'ETH',
      };

      const context: StrategyExecutionContext = {
        chainConfig: {
          protocol: 'ethereum',
          recipients: [],
          strategyConfig: {
            type: 'unknownBridge',
          },
        },
        funderConfig: { type: 'privateKey' },
      };

      const result = await strategy.execute(action, context, { signer: {} });
      expect(result.success).to.be.false;
      expect(result.error).to.include('Cannot determine rollup bridge type');
    });

    it('F5.B5: Arbitrum strategy correctly extracts signerAddress from getAddress method', async () => {
      const mockSigner = {
        getAddress: sinon.stub().resolves('0xCustomSignerAddress999'),
      };
      const mockInbox = {
        createRetryableTicket: sinon.stub().resolves({
          hash: '0xARB_SUCCESS',
          wait: sinon.stub().resolves({ gasUsed: 50000n }),
        }),
      };
      sinon.stub(strategy, 'getContract').callsFake(() => mockInbox as any);

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
        requiredFunding: ethers.parseEther('1.0'),
        formattedRequiredFunding: '1.0',
        funderAddress: '0xFunder',
        funderBalance: ethers.parseEther('10.0'),
        formattedFunderBalance: '10.0',
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
            inboxAddress: '0xInboxAddr',
          },
        },
        funderConfig: { type: 'privateKey' },
      };

      await strategy.execute(action, context, { signer: mockSigner });
      const refundAddress = mockInbox.createRetryableTicket.firstCall.args[3];
      expect(refundAddress).to.equal('0xCustomSignerAddress999');
    });
  });

  // ==========================================
  // Feature 6 Boundaries (5 tests)
  // ==========================================
  describe('F6 Boundaries: NonceAndGasManager', () => {
    it('F6.B1: Concurrent nonce requests across multiple workers maintain monotonic nonces with zero collisions', async () => {
      const nonceManager = new NonceManager();
      const mockProvider = {
        getTransactionCount: sinon.stub().resolves(100),
      };

      const results = await Promise.all([
        nonceManager.getAndIncrementNonce('ethereum', '0xFunder', mockProvider as any),
        nonceManager.getAndIncrementNonce('ethereum', '0xFunder', mockProvider as any),
        nonceManager.getAndIncrementNonce('ethereum', '0xFunder', mockProvider as any),
        nonceManager.getAndIncrementNonce('ethereum', '0xFunder', mockProvider as any),
        nonceManager.getAndIncrementNonce('ethereum', '0xFunder', mockProvider as any),
      ]);

      expect(results).to.deep.equal([100, 101, 102, 103, 104]);
    });

    it('F6.B2: NonceManager reset removes cached nonce allowing fresh query from provider', async () => {
      const nonceManager = new NonceManager();
      const mockProvider = {
        getTransactionCount: sinon.stub().onFirstCall().resolves(10).onSecondCall().resolves(50),
      };

      const n1 = await nonceManager.getNonce('ethereum', '0xFunder', mockProvider as any);
      expect(n1).to.equal(10);

      nonceManager.reset('ethereum', '0xFunder');

      const n2 = await nonceManager.getNonce('ethereum', '0xFunder', mockProvider as any);
      expect(n2).to.equal(50);
    });

    it('F6.B3: GasPriceManager with 100% bump doubles fee estimates accurately', () => {
      const gasManager = new GasPriceManager();
      const initial = {
        maxFeePerGas: ethers.parseUnits('40', 'gwei'),
        maxPriorityFeePerGas: ethers.parseUnits('2', 'gwei'),
        gasLimit: 21000n,
      };

      const bumped = gasManager.bumpFeeEstimates(initial, 100);
      expect(bumped.maxFeePerGas).to.equal(ethers.parseUnits('80', 'gwei'));
      expect(bumped.maxPriorityFeePerGas).to.equal(ethers.parseUnits('4', 'gwei'));
    });

    it('F6.B4: GasPriceManager fallback to legacy gasPrice when maxFeePerGas is null', async () => {
      const gasManager = new GasPriceManager();
      const mockProvider = {
        getFeeData: sinon.stub().resolves({
          maxFeePerGas: null,
          maxPriorityFeePerGas: null,
          gasPrice: ethers.parseUnits('25', 'gwei'),
        }),
      };

      const fees = await gasManager.getFeeEstimates(mockProvider as any, 1.2);
      expect(fees.maxFeePerGas).to.be.undefined;
      expect(fees.gasPrice).to.equal(ethers.parseUnits('30', 'gwei')); // 25 * 1.2
    });

    it('F6.B5: TransactionExecutor with dryRun simulates execution without sending transactions', async () => {
      const executor = new TransactionExecutor({ dryRun: true });
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

      const chainConfig: ChainFundingConfig = {
        protocol: 'ethereum',
        recipients: [],
      };

      const result = await executor.executeAction(action, chainConfig, { type: 'privateKey' });
      expect(result.success).to.be.true;
      expect(result.txHash).to.include('dryrun');
    });
  });

  // ==========================================
  // Feature 7 Boundaries (5 tests)
  // ==========================================
  describe('F7 Boundaries: KeyfunderCliAndDaemon', () => {
    it('F7.B1: formatActionsTable handles empty action list with empty indicator', () => {
      const tableStr = formatActionsTable([]);
      expect(tableStr).to.include('Chain'); expect(tableStr).to.include('Recipient');
    });

    it('F7.B2: formatBalancesTable handles empty balance reports gracefully', () => {
      const tableStr = formatBalancesTable({});
      expect(tableStr).to.include('Chain'); expect(tableStr).to.include('Role');
    });

    it('F7.B3: Metrics recordBalances handles invalid float strings without crashing', () => {
      const metrics = new KeyfunderMetrics();
      const reports: Record<string, ChainBalanceReport> = {
        ethereum: {
          chain: 'ethereum',
          protocol: 'ethereum',
          funderAddress: '0xFunder123',
          funderBalance: 0n,
          formattedFunderBalance: 'invalid-non-numeric',
          recipientBalances: [
            {
              recipient: '0xRec1',
              name: 'relayer',
              balance: 0n,
              formattedBalance: 'not-a-number',
              minBalance: 0n,
              formattedMinBalance: '0.0',
              desiredBalance: 0n,
              formattedDesiredBalance: '0.0',
              needsFunding: false,
              deficit: 0n,
              formattedDeficit: '0.0',
            },
          ],
        },
      };

      expect(() => metrics.recordBalances(reports)).to.not.throw();
    });

    it('F7.B4: Metrics server returns 404 for unknown endpoints', async () => {
      const metrics = new KeyfunderMetrics();
      await metrics.startServer(9877);
      try {
        const statusCode = await new Promise<number>((resolve, reject) => {
          http.get('http://localhost:9877/unknown-endpoint', (res) => {
            resolve(res.statusCode || 0);
          }).on('error', reject);
        });

        expect(statusCode).to.equal(404);
      } finally {
        await metrics.stopServer();
      }
    });

    it('F7.B5: Metrics server returns 200 OK with json uptime for /healthz endpoint', async () => {
      const metrics = new KeyfunderMetrics();
      await metrics.startServer(9878);
      try {
        const body = await new Promise<string>((resolve, reject) => {
          http.get('http://localhost:9878/healthz', (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => resolve(data));
          }).on('error', reject);
        });

        const parsed = JSON.parse(body);
        expect(parsed.status).to.equal('ok');
        expect(parsed.uptime).to.be.a('number');
      } finally {
        await metrics.stopServer();
      }
    });
  });
});
