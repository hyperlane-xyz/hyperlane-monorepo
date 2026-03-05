import { TransactionRequest } from 'ethers';

import {
  MultiCollateral,
  MultiCollateral__factory,
} from '@hyperlane-xyz/multicollateral';
import {
  Address,
  Domain,
  Numberish,
  addressToBytes32,
  assert,
  isAddressEvm,
  isZeroishAddress,
} from '@hyperlane-xyz/utils';

import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainName } from '../../types.js';

import { InterchainGasQuote } from './ITokenAdapter.js';
import { EvmHypCollateralAdapter } from './EvmTokenAdapter.js';

type PopulatedTransaction = TransactionRequest;

/**
 * Adapter for MultiCollateral routers.
 * Supports transferRemoteTo for both cross-chain and same-chain transfers.
 */
export class EvmHypMultiCollateralAdapter extends EvmHypCollateralAdapter {
  public readonly multiCollateralContract: MultiCollateral;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: {
      token: Address; // router address
      collateralToken?: Address; // optional hint for callers; resolved onchain
    },
  ) {
    super(chainName, multiProvider, { token: addresses.token });
    this.multiCollateralContract = MultiCollateral__factory.connect(
      addresses.token,
      this.getProvider(),
    );
  }

  // ============ MultiCollateral-specific methods ============

  /**
   * Populate cross-chain transfer to a specific target router.
   */
  private async quoteTransferRemoteToRaw(params: {
    destination: Domain;
    recipient: Address;
    amount: Numberish;
    targetRouter: Address;
  }) {
    const recipientBytes32 = addressToBytes32(params.recipient);
    const targetRouterBytes32 = addressToBytes32(params.targetRouter);

    return this.multiCollateralContract.quoteTransferRemoteTo(
      params.destination,
      recipientBytes32,
      params.amount.toString(),
      targetRouterBytes32,
    );
  }

  async populateTransferRemoteToTx(params: {
    destination: Domain;
    recipient: Address;
    amount: Numberish;
    targetRouter: Address;
    interchainGas?: InterchainGasQuote;
  }): Promise<PopulatedTransaction> {
    const recipientBytes32 = addressToBytes32(params.recipient);
    const targetRouterBytes32 = addressToBytes32(params.targetRouter);
    const quote =
      params.interchainGas ?? (await this.quoteTransferRemoteToGas(params));
    const nativeGas = !quote.igpQuote.addressOrDenom
      ? quote.igpQuote.amount.toString()
      : '0';

    return this.multiCollateralContract.transferRemoteTo.populateTransaction(
      params.destination,
      recipientBytes32,
      params.amount.toString(),
      targetRouterBytes32,
      { value: nativeGas },
    );
  }

  /**
   * Quote fees for transferRemoteTo.
   */
  async quoteTransferRemoteToGas(params: {
    destination: Domain;
    recipient: Address;
    amount: Numberish;
    targetRouter: Address;
  }): Promise<InterchainGasQuote> {
    const quotes = await this.quoteTransferRemoteToRaw(params);
    assert(
      quotes.length >= 3,
      'quoteTransferRemoteTo returned incomplete quote set',
    );
    assert(
      isZeroishAddress(quotes[1].token) || isAddressEvm(quotes[1].token),
      'quoteTransferRemoteTo returned invalid token fee denomination',
    );
    assert(
      quotes[2].token.toLowerCase() === quotes[1].token.toLowerCase(),
      'quoteTransferRemoteTo returned mismatched token fee denominations',
    );

    const amount = BigInt(params.amount.toString());
    const tokenQuoteAmount = BigInt(quotes[1].amount.toString());
    const externalFeeAmount = BigInt(quotes[2].amount.toString());
    const tokenFeeAmount =
      tokenQuoteAmount >= amount
        ? tokenQuoteAmount - amount + externalFeeAmount
        : externalFeeAmount;

    return {
      igpQuote: {
        amount: BigInt(quotes[0].amount.toString()),
        addressOrDenom: isZeroishAddress(quotes[0].token)
          ? undefined
          : quotes[0].token,
      },
      tokenFeeQuote: {
        addressOrDenom: quotes[1].token,
        amount: tokenFeeAmount,
      },
    };
  }
}
