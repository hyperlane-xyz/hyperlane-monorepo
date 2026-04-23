import { expect, vi } from 'vitest';
import { BigNumber } from 'ethers';

import { test1 } from '../../consts/testChains.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';

import { EvmHypCrossCollateralAdapter } from './EvmCrossCollateralAdapter.js';

describe('EvmHypCrossCollateralAdapter', () => {
  const ROUTER_ADDRESS = '0x1111111111111111111111111111111111111111';
  const COLLATERAL_ADDRESS = '0x2222222222222222222222222222222222222222';
  const TARGET_ROUTER = '0x3333333333333333333333333333333333333333';
  const RECIPIENT = '0x4444444444444444444444444444444444444444';
  const DESTINATION_DOMAIN = 31337;

  let adapter: EvmHypCrossCollateralAdapter;

  beforeEach(() => {
    const multiProvider =
      MultiProtocolProvider.createTestMultiProtocolProvider();
    adapter = new EvmHypCrossCollateralAdapter(test1.name, multiProvider, {
      token: ROUTER_ADDRESS,
      collateralToken: COLLATERAL_ADDRESS,
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('computes token fee as (quoted token out - input amount) + external fee', async () => {
    const quoteTransferRemoteTo = vi.fn().mockResolvedValue([
      { amount: BigNumber.from('1000'), token: COLLATERAL_ADDRESS },
      { amount: BigNumber.from('1500'), token: COLLATERAL_ADDRESS },
      { amount: BigNumber.from('25'), token: COLLATERAL_ADDRESS },
    ] as any);
    (adapter as any).crossCollateralContract = {
      quoteTransferRemoteTo,
    };

    const quote = await adapter.quoteTransferRemoteToGas({
      destination: DESTINATION_DOMAIN,
      recipient: RECIPIENT,
      amount: 1000n,
      targetRouter: TARGET_ROUTER,
    });

    expect(quote.igpQuote.amount).toBe(1000n);
    expect(quote.tokenFeeQuote?.amount).toBe(525n);
    expect(quote.tokenFeeQuote?.addressOrDenom).toBe(COLLATERAL_ADDRESS);
  });

  it('returns zero token fee when output equals input and external fee is zero', async () => {
    const quoteTransferRemoteTo = vi.fn().mockResolvedValue([
      { amount: BigNumber.from('7'), token: COLLATERAL_ADDRESS },
      { amount: BigNumber.from('123456'), token: COLLATERAL_ADDRESS },
      { amount: BigNumber.from('0'), token: COLLATERAL_ADDRESS },
    ] as any);
    (adapter as any).crossCollateralContract = {
      quoteTransferRemoteTo,
    };

    const quote = await adapter.quoteTransferRemoteToGas({
      destination: DESTINATION_DOMAIN,
      recipient: RECIPIENT,
      amount: 123456n,
      targetRouter: TARGET_ROUTER,
    });

    expect(quote.igpQuote.amount).toBe(7n);
    expect(quote.tokenFeeQuote?.amount).toBe(0n);
    expect(quote.tokenFeeQuote?.addressOrDenom).toBe(COLLATERAL_ADDRESS);
  });

  it('sets igp quote token when gas quote is non-native', async () => {
    const GAS_TOKEN = '0x5555555555555555555555555555555555555555';
    const quoteTransferRemoteTo = vi.fn().mockResolvedValue([
      { amount: BigNumber.from('777'), token: GAS_TOKEN },
      { amount: BigNumber.from('1500'), token: COLLATERAL_ADDRESS },
      { amount: BigNumber.from('10'), token: COLLATERAL_ADDRESS },
    ] as any);
    (adapter as any).crossCollateralContract = {
      quoteTransferRemoteTo,
    };

    const quote = await adapter.quoteTransferRemoteToGas({
      destination: DESTINATION_DOMAIN,
      recipient: RECIPIENT,
      amount: 1000n,
      targetRouter: TARGET_ROUTER,
    });

    expect(quote.igpQuote.amount).toBe(777n);
    expect(quote.igpQuote.addressOrDenom).toBe(GAS_TOKEN);
  });

  it('does not send native value when gas quote token is non-native', async () => {
    const GAS_TOKEN = '0x6666666666666666666666666666666666666666';
    const quoteTransferRemoteTo = vi.fn().mockResolvedValue([
      { amount: BigNumber.from('50'), token: GAS_TOKEN },
      { amount: BigNumber.from('1500'), token: COLLATERAL_ADDRESS },
      { amount: BigNumber.from('10'), token: COLLATERAL_ADDRESS },
    ] as any);
    const transferRemoteTo = vi.fn().mockResolvedValue({});
    (adapter as any).crossCollateralContract = {
      quoteTransferRemoteTo,
      populateTransaction: { transferRemoteTo },
    };

    await adapter.populateTransferRemoteToTx({
      destination: DESTINATION_DOMAIN,
      recipient: RECIPIENT,
      amount: 1000n,
      targetRouter: TARGET_ROUTER,
    });

    expect(transferRemoteTo).toHaveBeenCalledOnce();
    const callArgs = transferRemoteTo.mock.calls[0];
    expect(callArgs[4].value).toBe('0');
  });

  it('sends native value when gas quote token is native', async () => {
    const quoteTransferRemoteTo = vi.fn().mockResolvedValue([
      {
        amount: BigNumber.from('88'),
        token: '0x0000000000000000000000000000000000000000',
      },
      { amount: BigNumber.from('1500'), token: COLLATERAL_ADDRESS },
      { amount: BigNumber.from('10'), token: COLLATERAL_ADDRESS },
    ] as any);
    const transferRemoteTo = vi.fn().mockResolvedValue({});
    (adapter as any).crossCollateralContract = {
      quoteTransferRemoteTo,
      populateTransaction: { transferRemoteTo },
    };

    await adapter.populateTransferRemoteToTx({
      destination: DESTINATION_DOMAIN,
      recipient: RECIPIENT,
      amount: 1000n,
      targetRouter: TARGET_ROUTER,
    });

    expect(transferRemoteTo).toHaveBeenCalledOnce();
    const callArgs = transferRemoteTo.mock.calls[0];
    expect(callArgs[4].value).toBe('88');
  });

  it('throws when quote denominations mismatch', async () => {
    const quoteTransferRemoteTo = vi.fn().mockResolvedValue([
      {
        amount: BigNumber.from('88'),
        token: '0x0000000000000000000000000000000000000000',
      },
      { amount: BigNumber.from('1500'), token: COLLATERAL_ADDRESS },
      { amount: BigNumber.from('10'), token: TARGET_ROUTER },
    ] as any);
    (adapter as any).crossCollateralContract = {
      quoteTransferRemoteTo,
    };

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
    expect(thrown).not.toBe(undefined);
    expect(thrown!.message).toContain('mismatched token fee denominations');
  });
});
