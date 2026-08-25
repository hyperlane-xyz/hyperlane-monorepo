import { expect } from 'chai';
import sinon from 'sinon';
import { ethers } from 'ethers';
import { PublicKey } from '@solana/web3.js';
import { MultiProtocolBalanceMonitor } from '../src/core/MultiProtocolBalanceMonitor';
import { PolicyEvaluator } from '../src/core/PolicyEvaluator';
import { NonceManager } from '../src/execution/NonceManager';
import { GasPriceManager } from '../src/execution/GasPriceManager';
import { TransactionExecutor } from '../src/execution/TransactionExecutor';
import { SignerFactory } from '../src/execution/SignerFactory';
import { ChainBalanceReport, ChainFundingConfig, FundingAction, KeyfunderConfig } from '../src/types';

describe('Adversarial Empirical Challenge Suite (TypeScript Keyfunder)', () => {
  afterEach(() => {
    sinon.restore();
  });

  /* =========================================================================
   * 1. MULTI-PROTOCOL BALANCE FETCHING (RPC LATENCY, TIMEOUTS, RATE LIMITS)
   * ========================================================================= */
  describe('1. Multi-Protocol Balance Fetching Under Adversarial Conditions', () => {
    it('ADV-RPC-1: Multi-RPC Fallback under simulated 429 Rate Limits and intermittent errors', async () => {
      const monitor = new MultiProtocolBalanceMonitor({ timeoutMs: 1000, retryCount: 1 });
      const evmAddress = '0x1111111111111111111111111111111111111111';

      // Primary RPC always returns 429 Too Many Requests
      const primaryProvider = {
        getBalance: sinon.stub().rejects(new Error('429 Too Many Requests: rate limit exceeded')),
      };

      // Fallback RPC succeeds with balance
      const fallbackProvider = {
        getBalance: sinon.stub().resolves(ethers.parseEther('12.5')),
      };

      monitor.setEvmProvider('http://primary-rpc.local', primaryProvider as any);
      monitor.setEvmProvider('http://fallback-rpc.local', fallbackProvider as any);

      const chainConfig: ChainFundingConfig = {
        protocol: 'ethereum',
        rpcUrl: 'http://primary-rpc.local',
        fallbackRpcUrls: ['http://fallback-rpc.local'],
        recipients: [{ address: evmAddress }],
      };

      const balance = await monitor.getNativeBalance(chainConfig, evmAddress);
      expect(balance).to.equal(ethers.parseEther('12.5'));
      expect(primaryProvider.getBalance.called).to.be.true;
      expect(fallbackProvider.getBalance.called).to.be.true;
    });

    it('ADV-RPC-2: Timeout enforcement when primary RPC hangs indefinitely', async () => {
      const monitor = new MultiProtocolBalanceMonitor({ timeoutMs: 150, retryCount: 0 });
      const evmAddress = '0x2222222222222222222222222222222222222222';

      // Primary RPC hangs indefinitely
      const hangingProvider = {
        getBalance: sinon.stub().callsFake(() => new Promise((resolve) => setTimeout(resolve, 5000))),
      };

      // Fallback RPC responds promptly
      const fallbackProvider = {
        getBalance: sinon.stub().resolves(ethers.parseEther('3.14')),
      };

      monitor.setEvmProvider('http://hanging-rpc.local', hangingProvider as any);
      monitor.setEvmProvider('http://fast-fallback.local', fallbackProvider as any);

      const chainConfig: ChainFundingConfig = {
        protocol: 'ethereum',
        rpcUrl: 'http://hanging-rpc.local',
        fallbackRpcUrls: ['http://fast-fallback.local'],
        recipients: [{ address: evmAddress }],
      };

      const startTime = Date.now();
      const balance = await monitor.getNativeBalance(chainConfig, evmAddress);
      const elapsed = Date.now() - startTime;

      expect(balance).to.equal(ethers.parseEther('3.14'));
      expect(elapsed).to.be.lessThan(1000); // Timed out promptly on primary and fell back
    });

    it('ADV-RPC-3: Exhaustion of all RPCs throws structured error without unhandled rejection', async () => {
      const monitor = new MultiProtocolBalanceMonitor({ timeoutMs: 100, retryCount: 1 });
      const evmAddress = '0x3333333333333333333333333333333333333333';

      const failingProvider1 = {
        getBalance: sinon.stub().rejects(new Error('503 Service Unavailable')),
      };
      const failingProvider2 = {
        getBalance: sinon.stub().rejects(new Error('504 Gateway Timeout')),
      };

      monitor.setEvmProvider('http://rpc1.local', failingProvider1 as any);
      monitor.setEvmProvider('http://rpc2.local', failingProvider2 as any);

      const chainConfig: ChainFundingConfig = {
        protocol: 'ethereum',
        rpcUrl: 'http://rpc1.local',
        fallbackRpcUrls: ['http://rpc2.local'],
        recipients: [{ address: evmAddress }],
      };

      let errorCaught: any = null;
      try {
        await monitor.getNativeBalance(chainConfig, evmAddress);
      } catch (err: any) {
        errorCaught = err;
      }

      expect(errorCaught).to.not.be.null;
      expect(errorCaught.message).to.match(/503|504|Failed to execute/);
    });

    it('ADV-RPC-4: High-concurrency batch balance queries (50 recipients) across heterogeneous protocols', async () => {
      const monitor = new MultiProtocolBalanceMonitor({ maxConcurrency: 10, timeoutMs: 2000 });
      const recipients = Array.from({ length: 50 }, (_, i) => ({
        address: `0x${(i + 1).toString(16).padStart(40, '0')}`,
        minBalance: '1.0',
        desiredBalance: '5.0',
      }));

      const mockProvider = {
        getBalance: sinon.stub().callsFake(async (addr: string) => {
          // Simulate 5ms RPC round-trip delay
          await new Promise((r) => setTimeout(r, 5));
          const num = parseInt(addr.slice(-4), 16);
          return ethers.parseEther((num % 10).toString());
        }),
      };

      monitor.setEvmProvider('http://batch-evm.local', mockProvider as any);

      const chainConfig: ChainFundingConfig = {
        protocol: 'ethereum',
        rpcUrl: 'http://batch-evm.local',
        recipients,
      };

      const report = await monitor.getChainBalances('ethereum', chainConfig);
      expect(report.recipientBalances).to.have.lengthOf(50);
      expect(mockProvider.getBalance.callCount).to.equal(50);

      // Verify each recipient is parsed correctly
      for (let i = 0; i < 50; i++) {
        const item = report.recipientBalances[i];
        expect(item.recipient).to.equal(recipients[i].address);
        expect(item.desiredBalance).to.equal(ethers.parseEther('5.0'));
      }
    });

    it('ADV-RPC-5: Cosmos Stargate Client fallback to REST bank endpoint on RPC failure', async () => {
      const monitor = new MultiProtocolBalanceMonitor({ timeoutMs: 1000, retryCount: 0 });
      const cosmosAddr = 'cosmos1testuseraddress1234567890abcdefghij';

      // Stub Stargate client to fail
      const mockStargate = {
        getBalance: sinon.stub().rejects(new Error('Stargate gRPC connection refused')),
      };
      monitor.setCosmosClient('http://cosmos-rpc.local', mockStargate as any);

      // Stub global fetch for REST endpoint fallback
      const originalFetch = globalThis.fetch;
      const fetchStub = sinon.stub().callsFake(async (url: string) => {
        if (url.includes('/cosmos/bank/v1beta1/balances/')) {
          return {
            ok: true,
            json: async () => ({
              balance: {
                denom: 'uatom',
                amount: '42500000', // 42.5 ATOM
              },
            }),
          };
        }
        return { ok: false, statusText: 'Not Found' };
      });
      (globalThis as any).fetch = fetchStub;

      try {
        const chainConfig: ChainFundingConfig = {
          protocol: 'cosmos',
          rpcUrl: 'http://cosmos-rpc.local',
          strategyConfig: { denom: 'uatom', type: 'direct' },
          recipients: [{ address: cosmosAddr }],
        };

        const balance = await monitor.getNativeBalance(chainConfig, cosmosAddr);
        expect(balance).to.equal(42_500_000n);
        expect(mockStargate.getBalance.called).to.be.true;
        expect(fetchStub.called).to.be.true;
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('ADV-RPC-6: Solana SPL Token query with zero accounts vs aggregated token balance', async () => {
      const monitor = new MultiProtocolBalanceMonitor();
      const ownerPubkey = 'FhUbzaUQSLGicptKaeALgjwzwtjQLBASTMtFQrn3UdBX';
      const mintPubkey = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC

      // Case 1: Empty token accounts
      const mockSolConnEmpty = {
        getParsedTokenAccountsByOwner: sinon.stub().resolves({ value: [] }),
      };
      monitor.setSolanaConnection('http://sol-empty.local', mockSolConnEmpty as any);

      const chainConfigEmpty: ChainFundingConfig = {
        protocol: 'sealevel',
        rpcUrl: 'http://sol-empty.local',
        recipients: [],
      };

      const emptyBal = await monitor.getTokenBalance(chainConfigEmpty, ownerPubkey, mintPubkey);
      expect(emptyBal).to.equal(0n);

      // Case 2: Multiple SPL token accounts for the same mint
      const mockSolConnMulti = {
        getParsedTokenAccountsByOwner: sinon.stub().resolves({
          value: [
            { account: { data: { parsed: { info: { tokenAmount: { amount: '1500000' } } } } } },
            { account: { data: { parsed: { info: { tokenAmount: { amount: '3500000' } } } } } },
          ],
        }),
      };
      monitor.setSolanaConnection('http://sol-multi.local', mockSolConnMulti as any);

      const chainConfigMulti: ChainFundingConfig = {
        protocol: 'sealevel',
        rpcUrl: 'http://sol-multi.local',
        recipients: [],
      };

      const multiBal = await monitor.getTokenBalance(chainConfigMulti, ownerPubkey, mintPubkey);
      expect(multiBal).to.equal(5_000_000n); // 1.5 + 3.5 = 5.0 USDC
    });
  });

  /* =========================================================================
   * 2. POLICY EVALUATION (DECIMAL DISCREPANCIES, BOUNDARIES, RESERVE EXHAUSTION)
   * ========================================================================= */
  describe('2. Policy Evaluation Under Adversarial Scenarios & Decimal Discrepancies', () => {
    const evaluator = new PolicyEvaluator();

    it('ADV-POL-1: Cross-Protocol Decimals (EVM 18, Solana 9, Cosmos 6, WBTC 8)', () => {
      // 1. EVM (18 decimals)
      const evmConfig: ChainFundingConfig = {
        protocol: 'ethereum',
        nativeDecimals: 18,
        nativeSymbol: 'ETH',
        recipients: [{ address: '0x1111', policy: 'default' }],
      };
      const evmReport: ChainBalanceReport = {
        chain: 'ethereum',
        protocol: 'ethereum',
        funderAddress: '0xFunder',
        funderBalance: ethers.parseEther('10.0'),
        formattedFunderBalance: '10.0',
        recipientBalances: [
          {
            recipient: '0x1111',
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
      };
      const evmActions = evaluator.evaluateChain('ethereum', evmConfig, evmReport, {
        default: { minBalance: '0.5', desiredBalance: '2.0' },
      });
      expect(evmActions[0].requiredFunding).to.equal(ethers.parseEther('1.9'));
      expect(evmActions[0].decimals).to.equal(18);

      // 2. Solana (9 decimals)
      const solConfig: ChainFundingConfig = {
        protocol: 'sealevel',
        nativeDecimals: 9,
        nativeSymbol: 'SOL',
        recipients: [{ address: 'SolAddr123', policy: 'default' }],
      };
      const solReport: ChainBalanceReport = {
        chain: 'solana',
        protocol: 'sealevel',
        funderAddress: 'SolFunder',
        funderBalance: 100_000_000_000n, // 100 SOL
        formattedFunderBalance: '100.0',
        recipientBalances: [
          {
            recipient: 'SolAddr123',
            balance: 100_000_000n, // 0.1 SOL
            formattedBalance: '0.1',
            minBalance: 500_000_000n, // 0.5 SOL
            formattedMinBalance: '0.5',
            desiredBalance: 2_000_000_000n, // 2.0 SOL
            formattedDesiredBalance: '2.0',
            needsFunding: true,
            deficit: 1_900_000_000n,
            formattedDeficit: '1.9',
          },
        ],
      };
      const solActions = evaluator.evaluateChain('solana', solConfig, solReport, {
        default: { minBalance: '0.5', desiredBalance: '2.0' },
      });
      expect(solActions[0].requiredFunding).to.equal(1_900_000_000n);
      expect(solActions[0].decimals).to.equal(9);

      // 3. Cosmos (6 decimals)
      const cosmosConfig: ChainFundingConfig = {
        protocol: 'cosmos',
        nativeDecimals: 6,
        nativeSymbol: 'ATOM',
        recipients: [{ address: 'cosmos1addr', policy: 'default' }],
      };
      const cosmosReport: ChainBalanceReport = {
        chain: 'cosmoshub',
        protocol: 'cosmos',
        funderAddress: 'cosmos1funder',
        funderBalance: 100_000_000n, // 100 ATOM
        formattedFunderBalance: '100.0',
        recipientBalances: [
          {
            recipient: 'cosmos1addr',
            balance: 100_000n, // 0.1 ATOM
            formattedBalance: '0.1',
            minBalance: 500_000n, // 0.5 ATOM
            formattedMinBalance: '0.5',
            desiredBalance: 2_000_000n, // 2.0 ATOM
            formattedDesiredBalance: '2.0',
            needsFunding: true,
            deficit: 1_900_000n,
            formattedDeficit: '1.9',
          },
        ],
      };
      const cosmosActions = evaluator.evaluateChain('cosmoshub', cosmosConfig, cosmosReport, {
        default: { minBalance: '0.5', desiredBalance: '2.0' },
      });
      expect(cosmosActions[0].requiredFunding).to.equal(1_900_000n);
      expect(cosmosActions[0].decimals).to.equal(6);
    });

    it('ADV-POL-2: Extreme Decimal Precision and Sub-unit Fractional Boundaries', () => {
      const config: ChainFundingConfig = {
        protocol: 'cosmos',
        nativeDecimals: 6,
        recipients: [{ address: 'cosmos1user' }],
      };

      // Policy with 8 decimal places on a 6 decimal token ("0.00000001" - exceeds 6 decimals)
      const report: ChainBalanceReport = {
        chain: 'cosmos',
        protocol: 'cosmos',
        funderAddress: 'cosmos1funder',
        funderBalance: 10_000_000n,
        formattedFunderBalance: '10.0',
        recipientBalances: [
          {
            recipient: 'cosmos1user',
            balance: 0n,
            formattedBalance: '0.0',
            minBalance: 0n,
            formattedMinBalance: '0',
            desiredBalance: 0n,
            formattedDesiredBalance: '0',
            needsFunding: true,
            deficit: 0n,
            formattedDeficit: '0',
          },
        ],
      };

      // When fractional component exceeds decimals, evaluator parseUnits returns 0n safely
      const actions = evaluator.evaluateChain('cosmos', config, report, {
        invalidDecimals: { minBalance: '0.00000001', desiredBalance: '0.00000002' },
      });

      expect(actions).to.have.lengthOf(1);
      expect(actions[0].status).to.be.oneOf(['SKIPPED', 'PENDING']);
    });

    it('ADV-POL-3: Multi-Recipient Sequential Funder Reserve Exhaustion and Floor Protection', () => {
      const config: ChainFundingConfig = {
        protocol: 'ethereum',
        funderMinReserve: '2.0', // 2.0 ETH floor
        recipients: [
          { address: '0xAAAA', minBalance: '1.0', desiredBalance: '5.0' }, // Needs 5.0 ETH
          { address: '0xBBBB', minBalance: '1.0', desiredBalance: '5.0' }, // Needs 5.0 ETH
          { address: '0xCCCC', minBalance: '1.0', desiredBalance: '5.0' }, // Needs 5.0 ETH
        ],
      };

      // Funder balance = 10.0 ETH. Reserve floor = 2.0 ETH. Available to fund = 8.0 ETH.
      const report: ChainBalanceReport = {
        chain: 'ethereum',
        protocol: 'ethereum',
        funderAddress: '0xFunder',
        funderBalance: ethers.parseEther('10.0'),
        formattedFunderBalance: '10.0',
        recipientBalances: [
          {
            recipient: '0xAAAA',
            balance: 0n,
            formattedBalance: '0.0',
            minBalance: ethers.parseEther('1.0'),
            formattedMinBalance: '1.0',
            desiredBalance: ethers.parseEther('5.0'),
            formattedDesiredBalance: '5.0',
            needsFunding: true,
            deficit: ethers.parseEther('5.0'),
            formattedDeficit: '5.0',
          },
          {
            recipient: '0xBBBB',
            balance: 0n,
            formattedBalance: '0.0',
            minBalance: ethers.parseEther('1.0'),
            formattedMinBalance: '1.0',
            desiredBalance: ethers.parseEther('5.0'),
            formattedDesiredBalance: '5.0',
            needsFunding: true,
            deficit: ethers.parseEther('5.0'),
            formattedDeficit: '5.0',
          },
          {
            recipient: '0xCCCC',
            balance: 0n,
            formattedBalance: '0.0',
            minBalance: ethers.parseEther('1.0'),
            formattedMinBalance: '1.0',
            desiredBalance: ethers.parseEther('5.0'),
            formattedDesiredBalance: '5.0',
            needsFunding: true,
            deficit: ethers.parseEther('5.0'),
            formattedDeficit: '5.0',
          },
        ],
      };

      const actions = evaluator.evaluateChain('ethereum', config, report);

      expect(actions).to.have.lengthOf(3);

      // Recipient A gets full 5.0 ETH (Available left: 8.0 - 5.0 = 3.0 ETH)
      expect(actions[0].recipient).to.equal('0xAAAA');
      expect(actions[0].status).to.equal('PENDING');
      expect(actions[0].requiredFunding).to.equal(ethers.parseEther('5.0'));

      // Recipient B gets capped to remaining available 3.0 ETH (Available left: 0.0 ETH)
      expect(actions[1].recipient).to.equal('0xBBBB');
      expect(actions[1].status).to.equal('PENDING');
      expect(actions[1].requiredFunding).to.equal(ethers.parseEther('3.0'));

      // Recipient C is SKIPPED because reserve floor is reached
      expect(actions[2].recipient).to.equal('0xCCCC');
      expect(actions[2].status).to.equal('SKIPPED');
      expect(actions[2].skipReason).to.include('reserve floor');
    });

    it('ADV-POL-4: Max Funding Amount Cap per Single Top-Up Execution', () => {
      const config: ChainFundingConfig = {
        protocol: 'ethereum',
        recipients: [{ address: '0xRecipient', minBalance: '1.0', desiredBalance: '10.0', maxFundingAmount: '3.0' }],
      };

      const report: ChainBalanceReport = {
        chain: 'ethereum',
        protocol: 'ethereum',
        funderAddress: '0xFunder',
        funderBalance: ethers.parseEther('50.0'),
        formattedFunderBalance: '50.0',
        recipientBalances: [
          {
            recipient: '0xRecipient',
            balance: 0n,
            formattedBalance: '0.0',
            minBalance: ethers.parseEther('1.0'),
            formattedMinBalance: '1.0',
            desiredBalance: ethers.parseEther('10.0'),
            formattedDesiredBalance: '10.0',
            needsFunding: true,
            deficit: ethers.parseEther('10.0'),
            formattedDeficit: '10.0',
          },
        ],
      };

      const actions = evaluator.evaluateChain('ethereum', config, report);
      expect(actions).to.have.lengthOf(1);
      expect(actions[0].status).to.equal('PENDING');
      // Deficit is 10.0 ETH, but maxFundingAmount is 3.0 ETH -> must be capped at 3.0 ETH
      expect(actions[0].requiredFunding).to.equal(ethers.parseEther('3.0'));
    });

    it('ADV-POL-5: Exact Boundary Conditions at Threshold (current == minThreshold vs current == minThreshold - 1)', () => {
      const config: ChainFundingConfig = {
        protocol: 'ethereum',
        recipients: [
          { address: '0xExactEqual', minBalance: '1.0', desiredBalance: '3.0' },
          { address: '0xOneWeiBelow', minBalance: '1.0', desiredBalance: '3.0' },
          { address: '0xOneWeiAbove', minBalance: '1.0', desiredBalance: '3.0' },
        ],
      };

      const minThresholdWei = ethers.parseEther('1.0');

      const report: ChainBalanceReport = {
        chain: 'ethereum',
        protocol: 'ethereum',
        funderAddress: '0xFunder',
        funderBalance: ethers.parseEther('50.0'),
        formattedFunderBalance: '50.0',
        recipientBalances: [
          {
            recipient: '0xExactEqual',
            balance: minThresholdWei,
            formattedBalance: '1.0',
            minBalance: minThresholdWei,
            formattedMinBalance: '1.0',
            desiredBalance: ethers.parseEther('3.0'),
            formattedDesiredBalance: '3.0',
            needsFunding: false,
            deficit: 0n,
            formattedDeficit: '0.0',
          },
          {
            recipient: '0xOneWeiBelow',
            balance: minThresholdWei - 1n,
            formattedBalance: '0.999999999999999999',
            minBalance: minThresholdWei,
            formattedMinBalance: '1.0',
            desiredBalance: ethers.parseEther('3.0'),
            formattedDesiredBalance: '3.0',
            needsFunding: true,
            deficit: ethers.parseEther('2.0') + 1n,
            formattedDeficit: '2.000000000000000001',
          },
          {
            recipient: '0xOneWeiAbove',
            balance: minThresholdWei + 1n,
            formattedBalance: '1.000000000000000001',
            minBalance: minThresholdWei,
            formattedMinBalance: '1.0',
            desiredBalance: ethers.parseEther('3.0'),
            formattedDesiredBalance: '3.0',
            needsFunding: false,
            deficit: 0n,
            formattedDeficit: '0.0',
          },
        ],
      };

      const actions = evaluator.evaluateChain('ethereum', config, report);
      expect(actions[0].status).to.equal('SKIPPED'); // Exact equal
      expect(actions[1].status).to.equal('PENDING'); // 1-wei below
      expect(actions[1].requiredFunding).to.equal(ethers.parseEther('2.0') + 1n);
      expect(actions[2].status).to.equal('SKIPPED'); // 1-wei above
    });
  });

  /* =========================================================================
   * 3. TRANSACTION REPLACEMENT, NONCE DESYNCHRONIZATION & GAS SPIKES
   * ========================================================================= */
  describe('3. Transaction Replacement, Nonce Desync, & Dynamic Gas Spikes', () => {
    it('ADV-TX-1: High-Concurrency Nonce Monotonicity and Race Condition Prevention', async () => {
      const nonceManager = new NonceManager();
      const mockProvider = {
        getTransactionCount: sinon.stub().resolves(100),
      };

      // 40 concurrent tasks requesting next nonce on the same chain/address
      const tasks = Array.from({ length: 40 }, () =>
        nonceManager.getAndIncrementNonce('ethereum', '0xFunder', mockProvider as any)
      );

      const nonces = await Promise.all(tasks);

      // Verify all nonces are unique, continuous, and monotonically increasing
      expect(nonces).to.have.lengthOf(40);
      const sorted = [...nonces].sort((a, b) => a - b);
      for (let i = 0; i < 40; i++) {
        expect(sorted[i]).to.equal(100 + i);
      }
      expect(new Set(nonces).size).to.equal(40);
    });

    it('ADV-TX-2: Dynamic EIP-1559 Fee Bumping on Consecutive Retries during Gas Spikes', async () => {
      const gasManager = new GasPriceManager();

      const initialFees = {
        maxFeePerGas: ethers.parseUnits('30', 'gwei'),
        maxPriorityFeePerGas: ethers.parseUnits('2', 'gwei'),
        gasLimit: 21000n,
      };

      // Bump 1: 20% bump
      const bump1 = gasManager.bumpFeeEstimates(initialFees, 20);
      expect(bump1.maxPriorityFeePerGas).to.equal(ethers.parseUnits('2.4', 'gwei'));
      expect(bump1.maxFeePerGas).to.equal(ethers.parseUnits('36', 'gwei'));
      expect(bump1.maxFeePerGas! > bump1.maxPriorityFeePerGas!).to.be.true;

      // Bump 2: Consecutive 20% bump
      const bump2 = gasManager.bumpFeeEstimates(bump1, 20);
      expect(bump2.maxPriorityFeePerGas).to.equal(ethers.parseUnits('2.88', 'gwei'));
      expect(bump2.maxFeePerGas).to.equal(ethers.parseUnits('43.2', 'gwei'));

      // Bump 3: Extreme 100% surge bump
      const surgeBump = gasManager.bumpFeeEstimates(bump2, 100);
      expect(surgeBump.maxPriorityFeePerGas).to.equal(ethers.parseUnits('5.76', 'gwei'));
      expect(surgeBump.maxFeePerGas).to.equal(ethers.parseUnits('86.4', 'gwei'));
    });

    it('ADV-TX-3: Legacy Gas Price Bump when network lacks EIP-1559 support', () => {
      const gasManager = new GasPriceManager();

      const legacyFees = {
        gasPrice: ethers.parseUnits('50', 'gwei'),
        gasLimit: 21000n,
      };

      const bumped = gasManager.bumpFeeEstimates(legacyFees, 20);
      expect(bumped.gasPrice).to.equal(ethers.parseUnits('60', 'gwei'));
      expect(bumped.maxFeePerGas).to.be.undefined;
    });

    it('ADV-TX-4: Nonce Desync Auto-Recovery during Transaction Replacement', async () => {
      const nonceManager = new NonceManager();
      const gasManager = new GasPriceManager();
      const executor = new TransactionExecutor(
        { maxRetries: 2, gasBumpPercentage: 20 },
        nonceManager,
        gasManager
      );

      let getTxCountCalls = 0;
      const mockProvider = {
        getTransactionCount: sinon.stub().callsFake(async () => {
          getTxCountCalls++;
          if (getTxCountCalls === 1) return 10; // First cached query returns 10
          return 12; // On resync after failure, chain is at 12
        }),
        getFeeData: sinon.stub().resolves({
          maxFeePerGas: ethers.parseUnits('40', 'gwei'),
          maxPriorityFeePerGas: ethers.parseUnits('2', 'gwei'),
          gasPrice: null,
        }),
      };

      (executor as any).balanceMonitor.setEvmProvider('http://evm.local', mockProvider as any);

      let attempts = 0;
      const sentNonces: number[] = [];
      const mockSigner = {
        getAddress: sinon.stub().resolves('0xFunder'),
        sendTransaction: sinon.stub().callsFake(async (txReq: any) => {
          attempts++;
          sentNonces.push(txReq.nonce);
          if (attempts === 1) {
            // First attempt with nonce 10 fails because nonce was already consumed on-chain
            throw new Error('nonce too low: transaction already known or executed');
          }
          // Second attempt with resynced nonce 12 succeeds
          return {
            hash: '0xRESYNC_SUCCESS_TX_HASH_001',
            wait: sinon.stub().resolves({ gasUsed: 21000n }),
          };
        }),
      };

      sinon.stub(SignerFactory, 'getEvmSigner').resolves(mockSigner as any);

      const action: FundingAction = {
        chain: 'ethereum',
        protocol: 'ethereum',
        recipient: '0xRecipient123',
        currentBalance: 0n,
        formattedCurrentBalance: '0.0',
        minThreshold: 100n,
        formattedMinThreshold: '100',
        desiredBalance: 1000n,
        formattedDesiredBalance: '1000',
        requiredFunding: ethers.parseEther('1.0'),
        formattedRequiredFunding: '1.0',
        funderAddress: '0xFunder',
        funderBalance: ethers.parseEther('20.0'),
        formattedFunderBalance: '20.0',
        strategy: 'direct',
        status: 'PENDING',
        decimals: 18,
        symbol: 'ETH',
      };

      const chainConfig: ChainFundingConfig = {
        protocol: 'ethereum',
        rpcUrl: 'http://evm.local',
        recipients: [],
      };

      const funderConfig = {
        type: 'privateKey' as const,
        key: '0x0123456789012345678901234567890123456789012345678901234567890123',
      };

      const result = await executor.executeAction(action, chainConfig, funderConfig);
      expect(result.success).to.be.true;
      expect(result.txHash).to.equal('0xRESYNC_SUCCESS_TX_HASH_001');
      expect(attempts).to.equal(2);
      expect(sentNonces[0]).to.equal(10);
      expect(sentNonces[1]).to.equal(12); // Resynced to 12
    });

    it('ADV-TX-5: Cross-Chain Fault Isolation in executeAll (EVM Failure does not block Solana / Cosmos)', async () => {
      const executor = new TransactionExecutor({ dryRun: false });

      // Stub EVM action to fail
      sinon.stub(executor as any, 'executeEvmAction').resolves({
        success: false,
        error: 'EVM RPC Node Unreachable',
      });

      // Stub Solana action to succeed
      sinon.stub(executor as any, 'executeSolanaAction').resolves({
        success: true,
        txHash: '0xSOL_SUCCESS_TX_555',
      });

      // Stub Cosmos action to succeed
      sinon.stub(executor as any, 'executeCosmosAction').resolves({
        success: true,
        txHash: '0xCOSMOS_SUCCESS_TX_777',
      });

      const actions: FundingAction[] = [
        {
          chain: 'ethereum',
          protocol: 'ethereum',
          recipient: '0xEvmRecipient',
          currentBalance: 0n,
          formattedCurrentBalance: '0',
          minThreshold: 10n,
          formattedMinThreshold: '10',
          desiredBalance: 100n,
          formattedDesiredBalance: '100',
          requiredFunding: ethers.parseEther('1.0'),
          formattedRequiredFunding: '1.0',
          funderAddress: '0xEvmFunder',
          funderBalance: ethers.parseEther('10.0'),
          formattedFunderBalance: '10.0',
          strategy: 'direct',
          status: 'PENDING',
          decimals: 18,
          symbol: 'ETH',
        },
        {
          chain: 'solana',
          protocol: 'sealevel',
          recipient: 'SolRecipient',
          currentBalance: 0n,
          formattedCurrentBalance: '0',
          minThreshold: 10n,
          formattedMinThreshold: '10',
          desiredBalance: 100n,
          formattedDesiredBalance: '100',
          requiredFunding: 1_000_000_000n,
          formattedRequiredFunding: '1.0',
          funderAddress: 'SolFunder',
          funderBalance: 10_000_000_000n,
          formattedFunderBalance: '10.0',
          strategy: 'direct',
          status: 'PENDING',
          decimals: 9,
          symbol: 'SOL',
        },
        {
          chain: 'cosmoshub',
          protocol: 'cosmos',
          recipient: 'CosmosRecipient',
          currentBalance: 0n,
          formattedCurrentBalance: '0',
          minThreshold: 10n,
          formattedMinThreshold: '10',
          desiredBalance: 100n,
          formattedDesiredBalance: '100',
          requiredFunding: 1_000_000n,
          formattedRequiredFunding: '1.0',
          funderAddress: 'CosmosFunder',
          funderBalance: 10_000_000n,
          formattedFunderBalance: '10.0',
          strategy: 'direct',
          status: 'PENDING',
          decimals: 6,
          symbol: 'ATOM',
        },
      ];

      const config: KeyfunderConfig = {
        funder: {
          type: 'privateKey',
          key: '0x0123456789012345678901234567890123456789012345678901234567890123',
        },
        chains: {
          ethereum: { protocol: 'ethereum', recipients: [] },
          solana: { protocol: 'sealevel', recipients: [] },
          cosmoshub: { protocol: 'cosmos', recipients: [] },
        },
      };

      const results = await executor.executeAll(actions, config);

      const evmAction = results.find((a) => a.chain === 'ethereum');
      const solAction = results.find((a) => a.chain === 'solana');
      const cosmosAction = results.find((a) => a.chain === 'cosmoshub');

      expect(evmAction?.status).to.equal('FAILED');
      expect(evmAction?.error).to.include('EVM RPC Node Unreachable');

      expect(solAction?.status).to.equal('EXECUTED');
      expect(solAction?.txHash).to.equal('0xSOL_SUCCESS_TX_555');

      expect(cosmosAction?.status).to.equal('EXECUTED');
      expect(cosmosAction?.txHash).to.equal('0xCOSMOS_SUCCESS_TX_777');
    });
  });
});
