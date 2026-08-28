import { expect } from 'chai';
import sinon from 'sinon';
import { ethers } from 'ethers';
import { Connection, PublicKey } from '@solana/web3.js';
import { StargateClient } from '@cosmjs/stargate';
import http from 'http';

import { MultiProtocolBalanceMonitor } from '../src/core/MultiProtocolBalanceMonitor';
import { PolicyEvaluator } from '../src/core/PolicyEvaluator';
import { DirectNativeStrategy } from '../src/strategies/DirectNativeStrategy';
import { WarpRouteStrategy } from '../src/strategies/WarpRouteStrategy';
import { RollupBridgeStrategy } from '../src/strategies/RollupBridgeStrategy';
import { NonceManager } from '../src/execution/NonceManager';
import { GasPriceManager } from '../src/execution/GasPriceManager';
import { TransactionExecutor } from '../src/execution/TransactionExecutor';
import { SignerFactory } from '../src/execution/SignerFactory';
import { KeyfunderMetrics } from '../src/metrics/metrics';
import { createProgram, formatActionsTable, formatBalancesTable } from '../src/cli/index';
import {
  ChainBalanceReport,
  ChainFundingConfig,
  FunderConfig,
  FundingAction,
  FundingPolicy,
  StrategyExecutionContext,
} from '../src/types';

describe('Tier 1: Feature Coverage (TypeScript Keyfunder: F1 - F7)', () => {
  afterEach(() => {
    sinon.restore();
  });

  // ==========================================
  // Feature 1: MultiProtocolBalanceMonitor (5 tests)
  // ==========================================
  describe('F1: MultiProtocolBalanceMonitor', () => {
    let monitor: MultiProtocolBalanceMonitor;

    beforeEach(() => {
      monitor = new MultiProtocolBalanceMonitor();
    });

    it('F1.1: should query EVM native balance accurately', async () => {
      const mockProvider = {
        getBalance: sinon.stub().resolves(ethers.parseEther('2.5')),
      };
      monitor.setEvmProvider('http://127.0.0.1:8545', mockProvider as any);

      const chainConfig: ChainFundingConfig = {
        protocol: 'ethereum',
        rpcUrl: 'http://127.0.0.1:8545',
        recipients: [],
      };

      const balance = await monitor.getNativeBalance(chainConfig, '0x1111111111111111111111111111111111111111');
      expect(balance).to.equal(ethers.parseEther('2.5'));
      expect(mockProvider.getBalance.calledOnce).to.be.true;
    });

    it('F1.2: should query Solana native SOL balance accurately', async () => {
      const mockConnection = {
        getBalance: sinon.stub().resolves(1_500_000_000), // 1.5 SOL
      };
      monitor.setSolanaConnection('http://127.0.0.1:8899', mockConnection as any);

      const chainConfig: ChainFundingConfig = {
        protocol: 'sealevel',
        rpcUrl: 'http://127.0.0.1:8899',
        recipients: [],
      };

      const solanaAddress = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
      const balance = await monitor.getNativeBalance(chainConfig, solanaAddress);
      expect(balance).to.equal(1_500_000_000n);
      expect(mockConnection.getBalance.calledOnce).to.be.true;
    });

    it('F1.3: should query Cosmos SDK native balance accurately', async () => {
      const mockClient = {
        getBalance: sinon.stub().resolves({ denom: 'uatom', amount: '3500000' }),
      };
      monitor.setCosmosClient('http://127.0.0.1:26657', mockClient as any);

      const chainConfig: ChainFundingConfig = {
        protocol: 'cosmos',
        rpcUrl: 'http://127.0.0.1:26657',
        strategyConfig: { type: 'direct', denom: 'uatom' },
        recipients: [],
      };

      const cosmosAddress = 'cosmos1hsk6jryyqjfhp5dhc55tc9jtckygx0e86eh6cx';
      const balance = await monitor.getNativeBalance(chainConfig, cosmosAddress);
      expect(balance).to.equal(3500000n);
      expect(mockClient.getBalance.calledWith(cosmosAddress, 'uatom')).to.be.true;
    });

    it('F1.4: should query EVM ERC20 token balance accurately', async () => {
      const encodedBalance = ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [ethers.parseUnits('500', 6)]);
      const mockProvider = {
        call: sinon.stub().resolves(encodedBalance),
      };
      monitor.setEvmProvider('http://127.0.0.1:8545', mockProvider as any);

      const validTokenAddress = '0x1234567890123456789012345678901234567890';
      const validUserAddress = '0x2222222222222222222222222222222222222222';

      const chainConfig: ChainFundingConfig = {
        protocol: 'ethereum',
        rpcUrl: 'http://127.0.0.1:8545',
        recipients: [],
      };

      const balance = await monitor.getTokenBalance(chainConfig, validUserAddress, validTokenAddress);
      expect(balance).to.equal(ethers.parseUnits('500', 6));
    });

    it('F1.5: should query Solana SPL token balance accurately', async () => {
      const mockConnection = {
        getParsedTokenAccountsByOwner: sinon.stub().resolves({
          value: [
            {
              account: {
                data: {
                  parsed: {
                    info: {
                      tokenAmount: {
                        amount: '750000000',
                        decimals: 6,
                        uiAmountString: '750.0',
                      },
                    },
                  },
                },
              },
            },
          ],
        }),
      };
      monitor.setSolanaConnection('http://127.0.0.1:8899', mockConnection as any);

      const chainConfig: ChainFundingConfig = {
        protocol: 'sealevel',
        rpcUrl: 'http://127.0.0.1:8899',
        recipients: [],
      };

      const balance = await monitor.getTokenBalance(
        chainConfig,
        '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
      );
      expect(balance).to.equal(750000000n);
    });
  });

  // ==========================================
  // Feature 2: FundingPolicyEngine (5 tests)
  // ==========================================
  describe('F2: FundingPolicyEngine', () => {
    let evaluator: PolicyEvaluator;

    beforeEach(() => {
      evaluator = new PolicyEvaluator();
    });

    it('F2.1: should trigger funding action when balance is below minBalance', () => {
      const chainConfig: ChainFundingConfig = {
        protocol: 'ethereum',
        recipients: [{ address: '0xRec1', policy: 'default' }],
      };
      const policies: Record<string, FundingPolicy> = {
        default: { minBalance: '1.0', desiredBalance: '3.0' },
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
            balance: ethers.parseEther('0.5'),
            formattedBalance: '0.5',
            minBalance: ethers.parseEther('1.0'),
            formattedMinBalance: '1.0',
            desiredBalance: ethers.parseEther('3.0'),
            formattedDesiredBalance: '3.0',
            needsFunding: true,
            deficit: ethers.parseEther('2.5'),
            formattedDeficit: '2.5',
          },
        ],
      };

      const actions = evaluator.evaluateChain('ethereum', chainConfig, report, policies);
      expect(actions).to.have.lengthOf(1);
      expect(actions[0].status).to.equal('PENDING');
      expect(actions[0].requiredFunding).to.equal(ethers.parseEther('2.5'));
    });

    it('F2.2: should compute required funding as deficit up to desiredBalance', () => {
      const chainConfig: ChainFundingConfig = {
        protocol: 'ethereum',
        recipients: [{ address: '0xRec1', minBalance: '0.2', desiredBalance: '1.5' }],
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
            balance: ethers.parseEther('0.1'),
            formattedBalance: '0.1',
            minBalance: ethers.parseEther('0.2'),
            formattedMinBalance: '0.2',
            desiredBalance: ethers.parseEther('1.5'),
            formattedDesiredBalance: '1.5',
            needsFunding: true,
            deficit: ethers.parseEther('1.4'),
            formattedDeficit: '1.4',
          },
        ],
      };

      const actions = evaluator.evaluateChain('ethereum', chainConfig, report);
      expect(actions[0].requiredFunding).to.equal(ethers.parseEther('1.4'));
    });

    it('F2.3: should cap required funding when deficit exceeds maxFundingAmount', () => {
      const chainConfig: ChainFundingConfig = {
        protocol: 'ethereum',
        recipients: [{ address: '0xRec1', minBalance: '1.0', desiredBalance: '10.0', maxFundingAmount: '2.0' }],
      };
      const report: ChainBalanceReport = {
        chain: 'ethereum',
        protocol: 'ethereum',
        funderAddress: '0xFunder',
        funderBalance: ethers.parseEther('20.0'),
        formattedFunderBalance: '20.0',
        recipientBalances: [
          {
            recipient: '0xRec1',
            balance: ethers.parseEther('0.1'),
            formattedBalance: '0.1',
            minBalance: ethers.parseEther('1.0'),
            formattedMinBalance: '1.0',
            desiredBalance: ethers.parseEther('10.0'),
            formattedDesiredBalance: '10.0',
            needsFunding: true,
            deficit: ethers.parseEther('9.9'),
            formattedDeficit: '9.9',
          },
        ],
      };

      const actions = evaluator.evaluateChain('ethereum', chainConfig, report);
      expect(actions[0].requiredFunding).to.equal(ethers.parseEther('2.0'));
    });

    it('F2.4: should skip funding when balance is greater than or equal to minBalance', () => {
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
            balance: ethers.parseEther('1.5'),
            formattedBalance: '1.5',
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

    it('F2.5: should enforce funder minReserve floor and skip/cap accordingly', () => {
      const chainConfig: ChainFundingConfig = {
        protocol: 'ethereum',
        funderMinReserve: '5.0',
        recipients: [{ address: '0xRec1', minBalance: '1.0', desiredBalance: '4.0' }],
      };
      // Funder has 5.5 ETH, minReserve is 5.0 ETH -> Available is 0.5 ETH
      const report: ChainBalanceReport = {
        chain: 'ethereum',
        protocol: 'ethereum',
        funderAddress: '0xFunder',
        funderBalance: ethers.parseEther('5.5'),
        formattedFunderBalance: '5.5',
        recipientBalances: [
          {
            recipient: '0xRec1',
            balance: ethers.parseEther('0.0'),
            formattedBalance: '0.0',
            minBalance: ethers.parseEther('1.0'),
            formattedMinBalance: '1.0',
            desiredBalance: ethers.parseEther('4.0'),
            formattedDesiredBalance: '4.0',
            needsFunding: true,
            deficit: ethers.parseEther('4.0'),
            formattedDeficit: '4.0',
          },
        ],
      };

      const actions = evaluator.evaluateChain('ethereum', chainConfig, report);
      expect(actions[0].status).to.equal('PENDING');
      expect(actions[0].requiredFunding).to.equal(ethers.parseEther('0.5')); // Capped to available reserve
    });
  });

  // ==========================================
  // Feature 3: DirectNativeStrategy (5 tests)
  // ==========================================
  describe('F3: DirectNativeStrategy', () => {
    let strategy: DirectNativeStrategy;

    beforeEach(() => {
      strategy = new DirectNativeStrategy();
    });

    it('F3.1: should execute EVM direct native transfer with recipient and value', async () => {
      const mockSigner = {
        sendTransaction: sinon.stub().resolves({
          hash: '0xEVM_TX_123',
          wait: sinon.stub().resolves({ gasUsed: 21000n, gasPrice: ethers.parseUnits('20', 'gwei') }),
        }),
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

      const result = await strategy.execute(action, context, { signer: mockSigner });
      expect(result.success).to.be.true;
      expect(result.txHash).to.equal('0xEVM_TX_123');
      expect(mockSigner.sendTransaction.calledOnce).to.be.true;
      expect(mockSigner.sendTransaction.firstCall.args[0].to).to.equal(action.recipient);
      expect(mockSigner.sendTransaction.firstCall.args[0].value).to.equal(ethers.parseEther('1.0'));
    });

    it('F3.2: should execute Solana direct native transfer via sendAndConfirmTransaction', async () => {
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

      sinon.stub(strategy as any, 'executeSolana').resolves({
        success: true,
        txHash: '5xSOL_SIGNATURE_123',
      });

      const result = await strategy.execute(action, context, { keypair: {} });
      expect(result.success).to.be.true;
      expect(result.txHash).to.equal('5xSOL_SIGNATURE_123');
    });

    it('F3.3: should execute Cosmos direct native transfer via MsgSend', async () => {
      const mockCosmosClient = {
        sendTokens: sinon.stub().resolves({
          code: 0,
          transactionHash: 'COSMOS_TX_HASH_123',
          gasUsed: 75000n,
        }),
      };

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
        tokenDenom: 'uatom',
      };

      const context: StrategyExecutionContext = {
        chainConfig: { protocol: 'cosmos', recipients: [] },
        funderConfig: { type: 'privateKey' },
      };

      const result = await strategy.execute(action, context, { stargateClient: mockCosmosClient, funderAddress: 'cosmos1funder' });
      expect(result.success).to.be.true;
      expect(result.txHash).to.equal('COSMOS_TX_HASH_123');
    });

    it('F3.4: should return error failure if signer is missing for EVM', async () => {
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

      const result = await strategy.execute(action, context, {});
      expect(result.success).to.be.false;
      expect(result.error).to.include('Signer is required');
    });

    it('F3.5: should apply custom gas overrides during EVM direct transfer', async () => {
      const mockSigner = {
        sendTransaction: sinon.stub().resolves({
          hash: '0xEVM_OVERRIDE_TX',
          wait: sinon.stub().resolves({ gasUsed: 21000n }),
        }),
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

      const gasOverrides = {
        maxFeePerGas: ethers.parseUnits('50', 'gwei'),
        maxPriorityFeePerGas: ethers.parseUnits('2', 'gwei'),
      };

      await strategy.execute(action, context, { signer: mockSigner, gasOverrides });
      expect(mockSigner.sendTransaction.firstCall.args[0].maxFeePerGas).to.equal(ethers.parseUnits('50', 'gwei'));
    });
  });

  // ==========================================
  // Feature 4: WarpRouteBridgeStrategy (5 tests)
  // ==========================================
  describe('F4: WarpRouteBridgeStrategy', () => {
    let strategy: WarpRouteStrategy;

    beforeEach(() => {
      strategy = new WarpRouteStrategy();
    });

    it('F4.1: should format EVM recipient address to 32-byte hex padded string', () => {
      const evmAddress = '0x1111111111111111111111111111111111111111';
      const bytes32 = strategy.addressToBytes32(evmAddress, 'ethereum');
      expect(bytes32).to.have.lengthOf(66);
      expect(bytes32.toLowerCase()).to.equal('0x0000000000000000000000001111111111111111111111111111111111111111');
    });

    it('F4.2: should format Solana Base58 public key to 32-byte hex string', () => {
      const solPubkey = '11111111111111111111111111111111';
      const bytes32 = strategy.addressToBytes32(solPubkey, 'sealevel');
      expect(bytes32).to.have.lengthOf(66);
    });

    it('F4.3: should query gas quote and dispatch transferRemote', async () => {
      const mockSigner = {};
      const mockWarpContract = {
        quoteGasPayment: sinon.stub().resolves(ethers.parseEther('0.005')),
        transferRemote: sinon.stub().resolves({
          hash: '0xWARP_TX_123',
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
      expect(result.txHash).to.equal('0xWARP_TX_123');
      expect(mockWarpContract.quoteGasPayment.calledWith(2000)).to.be.true;
      expect(mockWarpContract.transferRemote.firstCall.args[3].value).to.equal(ethers.parseEther('1.005'));
    });

    it('F4.4: should approve ERC20 tokens before calling transferRemote if tokenAddress exists', async () => {
      const mockSigner = {
        getAddress: sinon.stub().resolves('0xFunderAddr'),
      };
      const mockWarpContract = {
        quoteGasPayment: sinon.stub().resolves(ethers.parseEther('0.002')),
        transferRemote: sinon.stub().resolves({
          hash: '0xWARP_ERC20_TX',
          wait: sinon.stub().resolves({ gasUsed: 150000n }),
        }),
      };
      const mockErc20 = {
        allowance: sinon.stub().resolves(0n),
        approve: sinon.stub().resolves({
          wait: sinon.stub().resolves({}),
        }),
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
      expect(mockErc20.approve.calledOnce).to.be.true;
    });

    it('F4.5: should return error if destinationDomain is not configured', async () => {
      const mockSigner = {};
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
          },
        },
        funderConfig: { type: 'privateKey' },
      };

      const result = await strategy.execute(action, context, { signer: mockSigner });
      expect(result.success).to.be.false;
      expect(result.error).to.include('destinationDomain');
    });
  });

  // ==========================================
  // Feature 5: RollupBridgeStrategy (5 tests)
  // ==========================================
  describe('F5: RollupBridgeStrategy', () => {
    let strategy: RollupBridgeStrategy;

    beforeEach(() => {
      strategy = new RollupBridgeStrategy();
    });

    it('F5.1: should execute OP Stack depositTransaction with parameters', async () => {
      const mockSigner = {};
      const mockPortal = {
        depositTransaction: sinon.stub().resolves({
          hash: '0xOP_TX_123',
          wait: sinon.stub().resolves({ gasUsed: 90000n }),
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
        requiredFunding: ethers.parseEther('0.8'),
        formattedRequiredFunding: '0.8',
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
            l2GasLimit: 250000,
          },
        },
        funderConfig: { type: 'privateKey' },
      };

      const result = await strategy.execute(action, context, { signer: mockSigner });
      expect(result.success).to.be.true;
      expect(result.txHash).to.equal('0xOP_TX_123');
      expect(mockPortal.depositTransaction.firstCall.args[0]).to.equal(action.recipient);
      expect(mockPortal.depositTransaction.firstCall.args[1]).to.equal(ethers.parseEther('0.8'));
      expect(mockPortal.depositTransaction.firstCall.args[2]).to.equal(250000);
    });

    it('F5.2: should execute Arbitrum createRetryableTicket with computed costs', async () => {
      const mockSigner = {
        getAddress: sinon.stub().resolves('0xSignerAddr'),
      };
      const mockInbox = {
        createRetryableTicket: sinon.stub().resolves({
          hash: '0xARB_TX_123',
          wait: sinon.stub().resolves({ gasUsed: 110000n }),
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
        requiredFunding: ethers.parseEther('1.5'),
        formattedRequiredFunding: '1.5',
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
            maxSubmissionCost: '0.002',
            maxGas: '100000',
            gasPriceBid: '0.2',
          },
        },
        funderConfig: { type: 'privateKey' },
      };

      const result = await strategy.execute(action, context, { signer: mockSigner });
      expect(result.success).to.be.true;
      expect(result.txHash).to.equal('0xARB_TX_123');
      expect(mockInbox.createRetryableTicket.calledOnce).to.be.true;
    });

    it('F5.3: should compute total msg.value including l2CallValue and retryable fee buffer for Arbitrum', async () => {
      const mockSigner = {
        getAddress: sinon.stub().resolves('0xSignerAddr'),
      };
      const mockInbox = {
        createRetryableTicket: sinon.stub().resolves({
          hash: '0xARB_VALUE_TX',
          wait: sinon.stub().resolves({ gasUsed: 100000n }),
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
            maxSubmissionCost: '0.001', // 0.001 ETH
            maxGas: '100000',
            gasPriceBid: '0.1', // 0.1 Gwei -> 100000 * 0.1e9 = 0.00001 ETH
          },
        },
        funderConfig: { type: 'privateKey' },
      };

      await strategy.execute(action, context, { signer: mockSigner });
      const txRequest = mockInbox.createRetryableTicket.firstCall.args[8];
      const expectedTotal = ethers.parseEther('1.0') + ethers.parseEther('0.001') + 100000n * ethers.parseUnits('0.1', 9);
      expect(txRequest.value).to.equal(expectedTotal);
    });

    it('F5.4: should return error if portalAddress is not configured for OP Stack', async () => {
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
        requiredFunding: ethers.parseEther('0.8'),
        formattedRequiredFunding: '0.8',
        funderAddress: '0xFunder',
        funderBalance: ethers.parseEther('10.0'),
        formattedFunderBalance: '10.0',
        strategy: 'opStackBridge',
        status: 'PENDING',
        decimals: 18,
        symbol: 'ETH',
      };

      const context: StrategyExecutionContext = {
        chainConfig: { protocol: 'ethereum', recipients: [] },
        funderConfig: { type: 'privateKey' },
      };

      const result = await strategy.execute(action, context, { signer: {} });
      expect(result.success).to.be.false;
      expect(result.error).to.include('portalAddress');
    });

    it('F5.5: should return error if inboxAddress is not configured for Arbitrum', async () => {
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
        requiredFunding: ethers.parseEther('1.5'),
        formattedRequiredFunding: '1.5',
        funderAddress: '0xFunder',
        funderBalance: ethers.parseEther('10.0'),
        formattedFunderBalance: '10.0',
        strategy: 'arbitrumInbox',
        status: 'PENDING',
        decimals: 18,
        symbol: 'ETH',
      };

      const context: StrategyExecutionContext = {
        chainConfig: { protocol: 'ethereum', recipients: [] },
        funderConfig: { type: 'privateKey' },
      };

      const result = await strategy.execute(action, context, { signer: {} });
      expect(result.success).to.be.false;
      expect(result.error).to.include('inboxAddress');
    });
  });

  // ==========================================
  // Feature 6: NonceAndGasManager (5 tests)
  // ==========================================
  describe('F6: NonceAndGasManager', () => {
    it('F6.1: NonceManager should increment nonce sequentially per chain', async () => {
      const nonceManager = new NonceManager();
      const mockProvider = {
        getTransactionCount: sinon.stub().resolves(15),
      };

      const n1 = await nonceManager.getAndIncrementNonce('ethereum', '0xFunder', mockProvider as any);
      const n2 = await nonceManager.getAndIncrementNonce('ethereum', '0xFunder', mockProvider as any);
      const n3 = await nonceManager.getAndIncrementNonce('ethereum', '0xFunder', mockProvider as any);

      expect(n1).to.equal(15);
      expect(n2).to.equal(16);
      expect(n3).to.equal(17);
      expect(mockProvider.getTransactionCount.calledOnce).to.be.true;
    });

    it('F6.2: NonceManager should resync nonce from provider upon reset', async () => {
      const nonceManager = new NonceManager();
      const mockProvider = {
        getTransactionCount: sinon.stub().onFirstCall().resolves(5).onSecondCall().resolves(20),
      };

      await nonceManager.getAndIncrementNonce('ethereum', '0xFunder', mockProvider as any);
      const synced = await nonceManager.resync('ethereum', '0xFunder', mockProvider as any);
      expect(synced).to.equal(20);
    });

    it('F6.3: GasPriceManager should calculate EIP-1559 dynamic fee estimates with buffer', async () => {
      const gasManager = new GasPriceManager();
      const mockProvider = {
        getFeeData: sinon.stub().resolves({
          maxFeePerGas: ethers.parseUnits('30', 'gwei'),
          maxPriorityFeePerGas: ethers.parseUnits('2', 'gwei'),
          gasPrice: null,
        }),
      };

      const fees = await gasManager.getFeeEstimates(mockProvider as any, 1.2);
      expect(fees.maxFeePerGas).to.equal(ethers.parseUnits('36', 'gwei')); // 30 * 1.2
      expect(fees.maxPriorityFeePerGas).to.equal(ethers.parseUnits('2.4', 'gwei')); // 2 * 1.2
    });

    it('F6.4: GasPriceManager should bump fee estimates by 20% on replacement retry', () => {
      const gasManager = new GasPriceManager();
      const initialFees = {
        maxFeePerGas: ethers.parseUnits('50', 'gwei'),
        maxPriorityFeePerGas: ethers.parseUnits('2', 'gwei'),
        gasLimit: 21000n,
      };

      const bumped = gasManager.bumpFeeEstimates(initialFees, 20);
      expect(bumped.maxFeePerGas).to.equal(ethers.parseUnits('60', 'gwei'));
      expect(bumped.maxPriorityFeePerGas).to.equal(ethers.parseUnits('2.4', 'gwei'));
    });

    it('F6.5: TransactionExecutor should execute action and return execution result', async () => {
      const executor = new TransactionExecutor({ maxRetries: 2 });
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
        rpcUrl: 'http://127.0.0.1:8545',
        recipients: [],
      };

      const funderConfig: FunderConfig = {
        type: 'privateKey',
        key: '0x0123456789012345678901234567890123456789012345678901234567890123',
      };

      const mockProvider = {
        getTransactionCount: sinon.stub().resolves(0),
        getFeeData: sinon.stub().resolves({
          maxFeePerGas: ethers.parseUnits('20', 'gwei'),
          maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei'),
          gasPrice: null,
        }),
      };

      (executor as any).balanceMonitor.setEvmProvider('http://127.0.0.1:8545', mockProvider as any);

      sinon.stub(SignerFactory, 'getEvmSigner').resolves({
        getAddress: sinon.stub().resolves('0xFunder123'),
        sendTransaction: sinon.stub().resolves({
          hash: '0xSUCCESS_TX_123',
          wait: sinon.stub().resolves({ gasUsed: 21000n }),
        }),
      } as any);

      const result = await executor.executeAction(action, chainConfig, funderConfig);
      expect(result.success).to.be.true;
      expect(result.txHash).to.equal('0xSUCCESS_TX_123');
    });
  });

  // ==========================================
  // Feature 7: KeyfunderCliAndDaemon (5 tests)
  // ==========================================
  describe('F7: KeyfunderCliAndDaemon', () => {
    it('F7.1: CLI program should register check, run, start, and topup commands', () => {
      const program = createProgram();
      const names = program.commands.map((c) => c.name());
      expect(names).to.include.members(['check', 'run', 'start', 'topup']);
    });

    it('F7.2: CLI should render formatted ASCII table for balance reports', () => {
      const reports: Record<string, ChainBalanceReport> = {
        ethereum: {
          chain: 'ethereum',
          protocol: 'ethereum',
          funderAddress: '0xFunder123',
          funderBalance: ethers.parseEther('15.0'),
          formattedFunderBalance: '15.0',
          recipientBalances: [
            {
              recipient: '0xRec1',
              name: 'relayer',
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
      };

      const tableStr = formatBalancesTable(reports);
      expect(tableStr).to.include('ethereum');
      expect(tableStr).to.include('relayer');
      expect(tableStr).to.include('YES');
    });

    it('F7.3: CLI should render formatted ASCII table for funding actions', () => {
      const actions: FundingAction[] = [
        {
          chain: 'ethereum',
          protocol: 'ethereum',
          recipient: '0x1234567890123456789012345678901234567890',
          recipientName: 'relayer-1',
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
      ];

      const tableStr = formatActionsTable(actions);
      expect(tableStr).to.include('ethereum');
      expect(tableStr).to.include('1.9 ETH');
      expect(tableStr).to.include('PENDING');
    });

    it('F7.4: Metrics collector should register balances and funding counts', () => {
      const metrics = new KeyfunderMetrics();
      const reports: Record<string, ChainBalanceReport> = {
        ethereum: {
          chain: 'ethereum',
          protocol: 'ethereum',
          funderAddress: '0xFunder123',
          funderBalance: ethers.parseEther('15.0'),
          formattedFunderBalance: '15.0',
          recipientBalances: [
            {
              recipient: '0xRec1',
              name: 'relayer',
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
      };

      metrics.recordBalances(reports);
      expect(metrics.balanceGauge).to.exist;
      expect(metrics.fundingActionsTotal).to.exist;
    });

    it('F7.5: Metrics HTTP server should respond with Prometheus metrics on /metrics', async () => {
      const metrics = new KeyfunderMetrics();
      const reports: Record<string, ChainBalanceReport> = {
        ethereum: {
          chain: 'ethereum',
          protocol: 'ethereum',
          funderAddress: '0xFunder123',
          funderBalance: ethers.parseEther('15.0'),
          formattedFunderBalance: '15.0',
          recipientBalances: [
            {
              recipient: '0xRec1',
              name: 'validator',
              balance: ethers.parseEther('3.0'),
              formattedBalance: '3.0',
              minBalance: ethers.parseEther('0.5'),
              formattedMinBalance: '0.5',
              desiredBalance: ethers.parseEther('2.0'),
              formattedDesiredBalance: '2.0',
              needsFunding: false,
              deficit: 0n,
              formattedDeficit: '0.0',
            },
          ],
        },
      };
      metrics.recordBalances(reports);

      const server = await metrics.startServer(9876);
      try {
        const body = await new Promise<string>((resolve, reject) => {
          http.get('http://localhost:9876/metrics', (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => resolve(data));
            res.on('error', reject);
          });
        });

        expect(body).to.include('keyfunder_balance_gauge');
        expect(body).to.include('0xRec1');
      } finally {
        await metrics.stopServer();
      }
    });
  });
});
