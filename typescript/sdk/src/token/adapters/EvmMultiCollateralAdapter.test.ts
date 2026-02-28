import { expect } from 'chai';
import { BigNumber } from 'ethers';
import sinon from 'sinon';

import { test1 } from '../../consts/testChains.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';

import { EvmHypMultiCollateralAdapter } from './EvmMultiCollateralAdapter.js';

describe('EvmHypMultiCollateralAdapter', () => {
  const ROUTER_ADDRESS = '0x1111111111111111111111111111111111111111';
  const COLLATERAL_ADDRESS = '0x2222222222222222222222222222222222222222';
  const TARGET_ROUTER = '0x3333333333333333333333333333333333333333';
  const RECIPIENT = '0x4444444444444444444444444444444444444444';
  const DESTINATION_DOMAIN = 31337;

  let adapter: EvmHypMultiCollateralAdapter;
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    const multiProvider =
      MultiProtocolProvider.createTestMultiProtocolProvider();
    adapter = new EvmHypMultiCollateralAdapter(test1.name, multiProvider, {
      token: ROUTER_ADDRESS,
      collateralToken: COLLATERAL_ADDRESS,
    });
  });

  afterEach(() => sandbox.restore());

  it('computes token fee as (quoted token out - input amount) + external fee', async () => {
    const quoteTransferRemoteTo = sinon.stub().resolves([
      { amount: BigNumber.from('1000'), token: COLLATERAL_ADDRESS },
      { amount: BigNumber.from('1500'), token: COLLATERAL_ADDRESS },
      { amount: BigNumber.from('25'), token: COLLATERAL_ADDRESS },
    ] as any);
    (adapter as any).contract = { quoteTransferRemoteTo };

    const quote = await adapter.quoteTransferRemoteToGas({
      destination: DESTINATION_DOMAIN,
      recipient: RECIPIENT,
      amount: 1000n,
      targetRouter: TARGET_ROUTER,
    });

    expect(quote.igpQuote.amount).to.equal(1000n);
    expect(quote.tokenFeeQuote?.amount).to.equal(525n);
    expect(quote.tokenFeeQuote?.addressOrDenom).to.equal(COLLATERAL_ADDRESS);
  });

  it('returns zero token fee when output equals input and external fee is zero', async () => {
    const quoteTransferRemoteTo = sinon.stub().resolves([
      { amount: BigNumber.from('7'), token: COLLATERAL_ADDRESS },
      { amount: BigNumber.from('123456'), token: COLLATERAL_ADDRESS },
      { amount: BigNumber.from('0'), token: COLLATERAL_ADDRESS },
    ] as any);
    (adapter as any).contract = { quoteTransferRemoteTo };

    const quote = await adapter.quoteTransferRemoteToGas({
      destination: DESTINATION_DOMAIN,
      recipient: RECIPIENT,
      amount: 123456n,
      targetRouter: TARGET_ROUTER,
    });

    expect(quote.igpQuote.amount).to.equal(7n);
    expect(quote.tokenFeeQuote?.amount).to.equal(0n);
    expect(quote.tokenFeeQuote?.addressOrDenom).to.equal(COLLATERAL_ADDRESS);
  });
});
