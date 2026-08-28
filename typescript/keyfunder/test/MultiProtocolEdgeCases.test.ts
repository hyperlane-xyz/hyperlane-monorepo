import { expect } from 'chai';
import sinon from 'sinon';
import { ethers } from 'ethers';
import { Connection, PublicKey } from '@solana/web3.js';
import { MultiProtocolBalanceMonitor } from '../src/core/MultiProtocolBalanceMonitor';
import { PolicyEvaluator } from '../src/core/PolicyEvaluator';
import { NonceManager } from '../src/execution/NonceManager';
import { GasPriceManager } from '../src/execution/GasPriceManager';
import { WarpRouteStrategy } from '../src/strategies/WarpRouteStrategy';
import { RollupBridgeStrategy } from '../src/strategies/RollupBridgeStrategy';
import { KeyFunder } from '../src/core/KeyFunder';
import { ChainFundingConfig, FundingAction, KeyfunderConfig } from '../src/types';

describe('Keyfunder Advanced Edge Cases & Boundary Scenarios', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('Solana SPL Token Balance Monitoring', () => {
    it('should query SPL token balance from parsed token accounts', async () => {
      const monitor = new MultiProtocolBalanceMonitor();
      const mockConn = sinon.createStubInstance(Connection);

      mockConn.getParsedTokenAccountsByOwner.resolves({
        value: [
          {
            pubkey: new PublicKey('11111111111111111111111111111111'),
            account: {
              executable: false,
              owner: new PublicKey('11111111111111111111111111111111'),
              lamports: 1000000,
              data: {
                program: 'spl-token',
                parsed: {
                  info: {
                    tokenAmount: {
                      amount: '50000000', // 50 tokens with 6 decimals
                      decimals: 6,
                      uiAmount: 50,
                    },
                  },
                  type: 'account',
                },
                space: 165,
              },
            },
          },
        ],
      } as any);

      monitor.setSolanaConnection('http://sol.rpc', mockConn as any);

      const chainConfig: ChainFundingConfig = {
        protocol: 'sealevel',
        rpcUrl: 'http://sol.rpc',
        recipients: [
          {
            address: '11111111111111111111111111111111',
            tokenAddress: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          },
        ],
      };

      const balance = await monitor.getRecipientBalance(
        chainConfig,
        chainConfig.recipients[0]
      );
      expect(balance).to.equal(50000000n);
    });
  });

  describe('Sequential Multi-Recipient Reserve Floor Depletion', () => {
    it('should fund first recipient and skip second when funder reserve is depleted', () => {
      const evaluator = new PolicyEvaluator();
      const chainConfig: ChainFundingConfig = {
        chain: 'ethereum',
        protocol: 'ethereum',
        funderMinReserve: '10.0', // Floor: 10 ETH
        recipients: [
          {
            name: 'recipient-1',
            address: '0xRec1',
            minBalance: '1.0',
            desiredBalance: '5.0', // needs 5.0 - 0 = 5.0 ETH
          },
          {
            name: 'recipient-2',
            address: '0xRec2',
            minBalance: '1.0',
            desiredBalance: '5.0', // needs 5.0 - 0 = 5.0 ETH
          },
        ],
      };

      // Funder has 13.0 ETH.
      // Available reserve before recipient 1: 13.0 - 10.0 = 3.0 ETH.
      // Recipient 1 gets capped to 3.0 ETH.
      // Simulated balance becomes 10.0 ETH (exact floor).
      // Recipient 2 gets SKIPPED because simulated balance <= floor.
      const report = {
        chain: 'ethereum',
        protocol: 'ethereum' as const,
        funderAddress: '0xFunder',
        funderBalance: ethers.parseEther('13.0'),
        formattedFunderBalance: '13.0',
        recipientBalances: [
          {
            recipient: '0xRec1',
            name: 'recipient-1',
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
            recipient: '0xRec2',
            name: 'recipient-2',
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

      const actions = evaluator.evaluateChain('ethereum', chainConfig, report);
      expect(actions).to.have.lengthOf(2);

      // Recipient 1 receives available reserve (3.0 ETH)
      expect(actions[0].status).to.equal('PENDING');
      expect(actions[0].requiredFunding).to.equal(ethers.parseEther('3.0'));

      // Recipient 2 is skipped because floor is reached
      expect(actions[1].status).to.equal('SKIPPED');
      expect(actions[1].skipReason).to.include('reserve floor');
    });
  });

  describe('WarpRouteStrategy ERC20 Token Approval Flow', () => {
    it('should check allowance, call approve, and call transferRemote for ERC20 routes', async () => {
      const strategy = new WarpRouteStrategy();

      const mockSigner = {
        getAddress: sinon.stub().resolves('0xSignerAddress'),
      };

      const mockTokenContract = {
        allowance: sinon.stub().resolves(0n), // 0 allowance initially
        approve: sinon.stub().resolves({
          wait: sinon.stub().resolves({}),
        }),
      };

      const mockWarpContract = {
        quoteGasPayment: sinon.stub().resolves(ethers.parseEther('0.002')),
        transferRemote: sinon.stub().resolves({
          hash: '0xERC20_WARP_HASH',
          wait: sinon.stub().resolves({ gasUsed: 180000n }),
        }),
      };

      sinon.stub(strategy, 'getContract').callsFake((addr: string) => {
        if (addr === '0xTokenContract') return mockTokenContract as any;
        return mockWarpContract as any;
      });

      const action: FundingAction = {
        chain: 'ethereum',
        protocol: 'ethereum',
        recipient: '0x2222222222222222222222222222222222222222',
        currentBalance: 0n,
        formattedCurrentBalance: '0',
        minThreshold: 100n,
        formattedMinThreshold: '100',
        desiredBalance: 1000n,
        formattedDesiredBalance: '1000',
        requiredFunding: ethers.parseUnits('100', 6), // 100 USDC
        formattedRequiredFunding: '100.0',
        funderAddress: '0xFunder',
        funderBalance: ethers.parseEther('10.0'),
        formattedFunderBalance: '10.0',
        strategy: 'warpRoute',
        status: 'PENDING',
        decimals: 6,
        symbol: 'USDC',
        tokenAddress: '0xTokenContract',
      };

      const context = {
        chainConfig: {
          protocol: 'ethereum' as const,
          recipients: [],
          strategyConfig: {
            type: 'warpRoute',
            warpRouteAddress: '0xWarpRouteAddress',
            destinationDomain: 2000,
          },
        },
        funderConfig: { type: 'privateKey' as const },
      };

      const result = await strategy.execute(action, context, { signer: mockSigner });
      expect(result.success).to.be.true;
      expect(result.txHash).to.equal('0xERC20_WARP_HASH');
      expect(mockTokenContract.approve.calledOnce).to.be.true;
      expect(mockWarpContract.transferRemote.calledOnce).to.be.true;

      // msg.value for ERC20 route must be the gas quote (0.002 ETH)
      const transferArgs = mockWarpContract.transferRemote.firstCall.args;
      expect(transferArgs[3].value).to.equal(ethers.parseEther('0.002'));
    });
  });

  describe('KeyFunder Daemon Mode Lifecycle', () => {
    it('should start daemon and stop daemon gracefully', async () => {
      const config: KeyfunderConfig = {
        funder: { type: 'privateKey', key: '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' },
        chains: {
          ethereum: {
            protocol: 'ethereum',
            rpcUrl: 'http://localhost:8545',
            recipients: [{ address: '0x123' }],
          },
        },
        dryRun: true,
        daemonIntervalSeconds: 1,
      };

      const keyfunder = new KeyFunder(config);
      sinon.stub(keyfunder, 'runOnce').resolves({ reports: {}, actions: [] });

      await keyfunder.startDaemon(1);
      expect((keyfunder as any).isRunning).to.be.true;

      await keyfunder.stopDaemon();
      expect((keyfunder as any).isRunning).to.be.false;
    });
  });
});
