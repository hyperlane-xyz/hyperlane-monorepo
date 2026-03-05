import { expect } from 'chai';
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
      { amount: 1000n, token: COLLATERAL_ADDRESS },
      { amount: 1500n, token: COLLATERAL_ADDRESS },
      { amount: 25n, token: COLLATERAL_ADDRESS },
    ] as any);
    (adapter as any).multiCollateralContract = { quoteTransferRemoteTo };

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
      { amount: 7n, token: COLLATERAL_ADDRESS },
      { amount: 123456n, token: COLLATERAL_ADDRESS },
      { amount: 0n, token: COLLATERAL_ADDRESS },
    ] as any);
    (adapter as any).multiCollateralContract = { quoteTransferRemoteTo };

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

  it('sets igp quote token when gas quote is non-native', async () => {
    const GAS_TOKEN = '0x5555555555555555555555555555555555555555';
    const quoteTransferRemoteTo = sinon.stub().resolves([
      { amount: 777n, token: GAS_TOKEN },
      { amount: 1500n, token: COLLATERAL_ADDRESS },
      { amount: 10n, token: COLLATERAL_ADDRESS },
    ] as any);
    (adapter as any).multiCollateralContract = { quoteTransferRemoteTo };

    const quote = await adapter.quoteTransferRemoteToGas({
      destination: DESTINATION_DOMAIN,
      recipient: RECIPIENT,
      amount: 1000n,
      targetRouter: TARGET_ROUTER,
    });

    expect(quote.igpQuote.amount).to.equal(777n);
    expect(quote.igpQuote.addressOrDenom).to.equal(GAS_TOKEN);
  });

  it('does not send native value when gas quote token is non-native', async () => {
    const GAS_TOKEN = '0x6666666666666666666666666666666666666666';
    const quoteTransferRemoteTo = sinon.stub().resolves([
      { amount: 50n, token: GAS_TOKEN },
      { amount: 1500n, token: COLLATERAL_ADDRESS },
      { amount: 10n, token: COLLATERAL_ADDRESS },
    ] as any);
    const transferRemoteTo = sinon.stub().resolves({});
    (adapter as any).multiCollateralContract = {
      quoteTransferRemoteTo,
      transferRemoteTo: { populateTransaction: transferRemoteTo },
    };

    await adapter.populateTransferRemoteToTx({
      destination: DESTINATION_DOMAIN,
      recipient: RECIPIENT,
      amount: 1000n,
      targetRouter: TARGET_ROUTER,
    });

    expect(transferRemoteTo.calledOnce).to.equal(true);
    const callArgs = transferRemoteTo.getCall(0).args;
    expect(callArgs[4].value).to.equal('0');
  });

  it('sends native value when gas quote token is native', async () => {
    const quoteTransferRemoteTo = sinon.stub().resolves([
      {
        amount: 88n,
        token: '0x0000000000000000000000000000000000000000',
      },
      { amount: 1500n, token: COLLATERAL_ADDRESS },
      { amount: 10n, token: COLLATERAL_ADDRESS },
    ] as any);
    const transferRemoteTo = sinon.stub().resolves({});
    (adapter as any).multiCollateralContract = {
      quoteTransferRemoteTo,
      transferRemoteTo: { populateTransaction: transferRemoteTo },
    };

    await adapter.populateTransferRemoteToTx({
      destination: DESTINATION_DOMAIN,
      recipient: RECIPIENT,
      amount: 1000n,
      targetRouter: TARGET_ROUTER,
    });

    expect(transferRemoteTo.calledOnce).to.equal(true);
    const callArgs = transferRemoteTo.getCall(0).args;
    expect(callArgs[4].value).to.equal('88');
  });

  it('throws when quote denominations mismatch', async () => {
    const quoteTransferRemoteTo = sinon.stub().resolves([
      {
        amount: 88n,
        token: '0x0000000000000000000000000000000000000000',
      },
      { amount: 1500n, token: COLLATERAL_ADDRESS },
      { amount: 10n, token: TARGET_ROUTER },
    ] as any);
    (adapter as any).multiCollateralContract = { quoteTransferRemoteTo };

    let thrown: Error | undefined;
    try {
      await adapter.quoteTransferRemoteToGas({
        destination: DESTINATION_DOMAIN,
        recipient: RECIPIENT,
        amount: 1000n,
        targetRouter: TARGET_ROUTER,
      });
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown).to.not.equal(undefined);
    expect(thrown!.message).to.contain('mismatched token fee denominations');
  });
});
