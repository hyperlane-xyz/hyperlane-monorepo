import { expect } from 'chai';
import sinon from 'sinon';
import { StrategyRouter } from '../../src/strategies/StrategyRouter';
import { IFundingStrategy } from '../../src/strategies/IFundingStrategy';
import { FundingAction, StrategyExecutionContext } from '../../src/types';

describe('StrategyRouter', () => {
  let router: StrategyRouter;

  beforeEach(() => {
    router = new StrategyRouter();
  });

  it('should have default built-in strategies registered', () => {
    expect(router.hasStrategy('direct')).to.be.true;
    expect(router.hasStrategy('warpRoute')).to.be.true;
    expect(router.hasStrategy('opStackBridge')).to.be.true;
    expect(router.hasStrategy('arbitrumInbox')).to.be.true;
  });

  it('should allow registering custom strategy', async () => {
    const customStrategy: IFundingStrategy = {
      name: 'custom_funder',
      execute: sinon.stub().resolves({
        success: true,
        txHash: '0xCUSTOM_123',
      }),
    };

    router.registerStrategy('custom_funder', customStrategy);
    expect(router.hasStrategy('custom_funder')).to.be.true;

    const action: FundingAction = {
      chain: 'ethereum',
      protocol: 'ethereum',
      recipient: '0x123',
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
      strategy: 'custom_funder',
      status: 'PENDING',
      decimals: 18,
      symbol: 'ETH',
    };

    const context: StrategyExecutionContext = {
      chainConfig: { protocol: 'ethereum', recipients: [] },
      funderConfig: { type: 'privateKey' },
    };

    const result = await router.execute(action, context);
    expect(result.success).to.be.true;
    expect(result.txHash).to.equal('0xCUSTOM_123');
  });

  it('should throw error when accessing unregistered strategy', () => {
    expect(() => router.getStrategy('non_existent_strategy')).to.throw(
      'is not registered'
    );
  });
});
