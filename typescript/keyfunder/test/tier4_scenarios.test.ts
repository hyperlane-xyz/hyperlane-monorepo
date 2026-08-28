import { expect } from 'chai';
import sinon from 'sinon';
import { ethers } from 'ethers';

import { KeyFunder } from '../src/core/KeyFunder';
import { NonceManager } from '../src/execution/NonceManager';
import { GasPriceManager } from '../src/execution/GasPriceManager';
import { TransactionExecutor } from '../src/execution/TransactionExecutor';
import { SignerFactory } from '../src/execution/SignerFactory';
import { KeyfunderMetrics } from '../src/metrics/metrics';
import { validateConfig } from '../src/config/schema';
import { ChainFundingConfig, FundingAction, KeyfunderConfig } from '../src/types';

describe('Tier 4: Real-World Application Scenarios (TypeScript Keyfunder: S1 - S2)', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('Scenario 1 (S1): Complete Multi-Chain Relayer Top-Up Lifecycle across EVM, Solana, and Cosmos', async () => {
    const solFunderPubkey = 'BJoksgA5Pa5XrcUy1ccptMXdfia3mMR7ACF9aLi7HuCP';
    const solRecipientPubkey = 'FhUbzaUQSLGicptKaeALgjwzwtjQLBASTMtFQrn3UdBX';
    const evmRecipient = '0x1111111111111111111111111111111111111111';
    const cosmosRecipient = 'cosmos1hsk6jryyqjfhp5dhc55tc9jtckygx0e86eh6cx';

    // 1. Initial multi-chain balances state
    const balances = {
      evm_funder: ethers.parseEther('100.0'),
      evm_relayer: ethers.parseEther('0.1'), // Needs top-up to 2.0 ETH
      sol_funder: 100_000_000_000n, // 100 SOL
      sol_relayer: 200_000_000n, // 0.2 SOL -> Needs top-up to 1.5 SOL
      cosmos_funder: 100_000_000n, // 100 ATOM
      cosmos_relayer: 1_000_000n, // 1 ATOM -> Needs top-up to 5 ATOM
    };

    sinon.stub(SignerFactory, 'getFunderAddress').callsFake(async (protocol: string) => {
      if (protocol === 'ethereum') return '0xFunderEvm12345678901234567890123456789012';
      if (protocol === 'sealevel') return solFunderPubkey;
      return 'cosmos1funder123456789012345678901234567890';
    });

    const mockEvmProvider = {
      getBalance: sinon.stub().callsFake((addr: string) => {
        if (addr.toLowerCase() === evmRecipient.toLowerCase()) {
          return Promise.resolve(balances.evm_relayer);
        }
        return Promise.resolve(balances.evm_funder);
      }),
      getTransactionCount: sinon.stub().resolves(0),
      getFeeData: sinon.stub().resolves({
        maxFeePerGas: ethers.parseUnits('30', 'gwei'),
        maxPriorityFeePerGas: ethers.parseUnits('2', 'gwei'),
        gasPrice: null,
      }),
    };

    const mockSolConnection = {
      getBalance: sinon.stub().callsFake((pubkey: any) => {
        const pkStr = pubkey.toBase58 ? pubkey.toBase58() : pubkey.toString();
        if (pkStr === solRecipientPubkey) {
          return Promise.resolve(Number(balances.sol_relayer));
        }
        return Promise.resolve(Number(balances.sol_funder));
      }),
    };

    const mockCosmosClient = {
      getBalance: sinon.stub().callsFake((addr: string) => {
        if (addr === cosmosRecipient) {
          return Promise.resolve({ denom: 'uatom', amount: balances.cosmos_relayer.toString() });
        }
        return Promise.resolve({ denom: 'uatom', amount: balances.cosmos_funder.toString() });
      }),
    };

    const rawConfig: KeyfunderConfig = {
      funder: {
        type: 'privateKey',
        key: '0x0123456789012345678901234567890123456789012345678901234567890123',
      },
      chains: {
        ethereum: {
          protocol: 'ethereum',
          rpcUrl: 'http://evm.local',
          recipients: [{ name: 'evm-relayer', address: evmRecipient, minBalance: '0.5', desiredBalance: '2.0' }],
        },
        solana: {
          protocol: 'sealevel',
          rpcUrl: 'http://sol.local',
          recipients: [{ name: 'sol-relayer', address: solRecipientPubkey, minBalance: '0.5', desiredBalance: '1.5' }],
        },
        cosmoshub: {
          protocol: 'cosmos',
          rpcUrl: 'http://cosmos.local',
          strategyConfig: { type: 'direct', denom: 'uatom' },
          recipients: [{ name: 'cosmos-relayer', address: cosmosRecipient, minBalance: '2.0', desiredBalance: '5.0' }],
        },
      },
    };

    const config = validateConfig(rawConfig);

    const funder = new KeyFunder(config);
    funder.balanceMonitor.setEvmProvider('http://evm.local', mockEvmProvider as any);
    funder.balanceMonitor.setSolanaConnection('http://sol.local', mockSolConnection as any);
    funder.balanceMonitor.setCosmosClient('http://cosmos.local', mockCosmosClient as any);

    // 2. Step 1: Run check()
    const checkReport = await funder.check();
    expect(checkReport.actions).to.have.lengthOf(3);
    expect(checkReport.actions.every((a) => a.status === 'PENDING')).to.be.true;

    // 3. Step 2: Run dryRun execution
    const runResult = await funder.runOnce({ dryRun: true });
    expect(runResult.actions).to.have.lengthOf(3);
    expect(runResult.actions.every((a) => a.status === 'EXECUTED')).to.be.true;
    expect(runResult.actions[0].txHash).to.include('dryrun');

    // 4. Step 3: Simulate top-up reflection in balance state
    balances.evm_relayer = ethers.parseEther('2.0');
    balances.sol_relayer = 1_500_000_000n;
    balances.cosmos_relayer = 5_000_000n;

    // 5. Step 4: Run check() again and verify all relayers healthy (all SKIPPED)
    const postCheck = await funder.check();
    expect(postCheck.actions.every((a) => a.status === 'SKIPPED')).to.be.true;
    expect(postCheck.reports.ethereum.recipientBalances[0].needsFunding).to.be.false;
    expect(postCheck.reports.solana.recipientBalances[0].needsFunding).to.be.false;
    expect(postCheck.reports.cosmoshub.recipientBalances[0].needsFunding).to.be.false;
  });

  it('Scenario 2 (S2): Cross-Chain Warp Route & L2 Rollup Bridge Funding under Dynamic Gas Surge & Nonce Resync', async () => {
    const nonceManager = new NonceManager();
    const gasPriceManager = new GasPriceManager(1.2);
    const metrics = new KeyfunderMetrics();
    const executor = new TransactionExecutor(
      { maxRetries: 2, gasBumpPercentage: 20 },
      nonceManager,
      gasPriceManager
    );

    // 1. Simulate initial transaction nonce desync & gas surge
    const mockProvider = {
      getTransactionCount: sinon.stub().onFirstCall().resolves(5).onSecondCall().resolves(7),
      getFeeData: sinon.stub().resolves({
        maxFeePerGas: ethers.parseUnits('40', 'gwei'),
        maxPriorityFeePerGas: ethers.parseUnits('2', 'gwei'),
        gasPrice: null,
      }),
    };

    (executor as any).balanceMonitor.setEvmProvider('http://127.0.0.1:8545', mockProvider as any);

    // Signer fails on first attempt with nonce error, then succeeds on retry with bumped fee
    let attempts = 0;
    const mockSigner = {
      getAddress: sinon.stub().resolves('0xFunder123456789012345678901234567890123456'),
      sendTransaction: sinon.stub().callsFake(async (txRequest: any) => {
        attempts++;
        if (attempts === 1) {
          throw new Error('nonce too low: replacement transaction underpriced');
        }
        return {
          hash: '0xWARP_RETRY_SUCCESS_TX_999',
          wait: sinon.stub().resolves({ gasUsed: 125000n }),
        };
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
      requiredFunding: ethers.parseEther('1.5'),
      formattedRequiredFunding: '1.5',
      funderAddress: '0xFunder123456789012345678901234567890123456',
      funderBalance: ethers.parseEther('20.0'),
      formattedFunderBalance: '20.0',
      strategy: 'warpRoute',
      status: 'PENDING',
      decimals: 18,
      symbol: 'ETH',
    };

    const chainConfig: ChainFundingConfig = {
      protocol: 'ethereum',
      rpcUrl: 'http://127.0.0.1:8545',
      strategyConfig: {
        type: 'warpRoute',
        warpRouteAddress: '0xWarpRoute12345678901234567890123456789012',
        destinationDomain: 2000,
      },
      recipients: [],
    };

    const funderConfig = {
      type: 'privateKey' as const,
      key: '0x0123456789012345678901234567890123456789012345678901234567890123',
    };

    const warpContractMock = {
      quoteGasPayment: sinon.stub().resolves(ethers.parseEther('0.005')),
      transferRemote: sinon.stub().callsFake(async () => {
        return mockSigner.sendTransaction({});
      }),
    };

    sinon.stub(executor.getStrategyRouter().getStrategy('warpRoute') as any, 'getContract').callsFake(() => warpContractMock as any);

    // 2. Execute action with retry and nonce resync
    const result = await executor.executeAction(action, chainConfig, funderConfig);
    expect(result.success).to.be.true;
    expect(result.txHash).to.equal('0xWARP_RETRY_SUCCESS_TX_999');
    expect(attempts).to.equal(2);

    // 3. Record metrics for executed action
    action.status = 'EXECUTED';
    action.txHash = result.txHash;
    metrics.recordActions([action]);
    expect(metrics.fundingActionsTotal).to.exist;
  });
});
