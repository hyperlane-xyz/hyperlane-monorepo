import { expect } from 'chai';
import sinon from 'sinon';
import { ethers } from 'ethers';
import { WarpRouteStrategy } from '../../src/strategies/WarpRouteStrategy';
import { FundingAction, StrategyExecutionContext } from '../../src/types';

describe('WarpRouteStrategy', () => {
  let strategy: WarpRouteStrategy;

  beforeEach(() => {
    strategy = new WarpRouteStrategy();
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should convert EVM address to 32-byte hex padded format', () => {
    const evmAddr = '0x1111111111111111111111111111111111111111';
    const bytes32 = strategy.addressToBytes32(evmAddr, 'ethereum');
    expect(bytes32).to.have.lengthOf(66);
    expect(bytes32.startsWith('0x0000000000000000000000001111111111111111111111111111111111111111')).to.be.true;
  });

  it('should convert Solana Base58 pubkey to 32-byte hex string', () => {
    const solAddr = '11111111111111111111111111111111';
    const bytes32 = strategy.addressToBytes32(solAddr, 'sealevel');
    expect(bytes32).to.have.lengthOf(66);
    expect(bytes32.startsWith('0x')).to.be.true;
  });

  it('should execute transferRemote with gas quote and funding value', async () => {
    const mockSigner = {
      getAddress: sinon.stub().resolves('0xFunderSigner'),
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
      funderBalance: ethers.parseEther('100.0'),
      formattedFunderBalance: '100.0',
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
          warpRouteAddress: '0xWarpRouteContractAddress123456789012345678',
          destinationDomain: 1000,
        },
      },
      funderConfig: { type: 'privateKey' },
    };

    const mockWarpContract = {
      quoteGasPayment: sinon.stub().resolves(ethers.parseEther('0.005')),
      transferRemote: sinon.stub().resolves({
        hash: '0xWARP_TX_HASH_123',
        wait: sinon.stub().resolves({ gasUsed: 150000n, gasPrice: ethers.parseUnits('20', 'gwei') }),
      }),
    };

    sinon.stub(strategy, 'getContract').callsFake(() => mockWarpContract as any);

    const result = await strategy.execute(action, context, { signer: mockSigner });
    expect(result.success).to.be.true;
    expect(result.txHash).to.equal('0xWARP_TX_HASH_123');
    expect(mockWarpContract.transferRemote.calledOnce).to.be.true;

    // Check args passed to transferRemote
    const args = mockWarpContract.transferRemote.firstCall.args;
    expect(args[0]).to.equal(1000); // destinationDomain
    expect(args[2]).to.equal(ethers.parseEther('1.0')); // requiredFunding
    expect(args[3].value).to.equal(ethers.parseEther('1.005')); // 1.0 funding + 0.005 quote
  });

  it('should return error if warpRouteAddress is not configured', async () => {
    const mockSigner = {};
    const action: FundingAction = {
      chain: 'ethereum',
      protocol: 'ethereum',
      recipient: '0x222',
      currentBalance: 0n,
      formattedCurrentBalance: '0',
      minThreshold: 0n,
      formattedMinThreshold: '0',
      desiredBalance: 100n,
      formattedDesiredBalance: '100',
      requiredFunding: 100n,
      formattedRequiredFunding: '100',
      funderAddress: '0xFunder',
      funderBalance: 1000n,
      formattedFunderBalance: '1000',
      strategy: 'warpRoute',
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
    expect(result.error).to.include('warpRouteAddress is not specified');
  });
});
