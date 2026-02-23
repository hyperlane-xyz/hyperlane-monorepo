import { PopulatedTransaction } from 'ethers';

import { MultiCollateral, MultiCollateral__factory } from '@hyperlane-xyz/core';
import {
  Address,
  Domain,
  Numberish,
  addressToBytes32,
} from '@hyperlane-xyz/utils';

import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainName } from '../../types.js';

import { InterchainGasQuote } from './ITokenAdapter.js';
import { EvmMovableCollateralAdapter } from './EvmTokenAdapter.js';

/**
 * Adapter for MultiCollateral routers.
 * Extends EvmMovableCollateralAdapter (inheriting rebalance support) and adds
 * transferRemoteTo for cross-asset transfers (both cross-chain and same-chain).
 */
export class EvmHypMultiCollateralAdapter extends EvmMovableCollateralAdapter {
  public readonly multiCollateralContract: MultiCollateral;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: {
      token: Address; // router address
      collateralToken: Address; // underlying ERC20
    },
  ) {
    super(chainName, multiProvider, addresses);
    this.multiCollateralContract = MultiCollateral__factory.connect(
      addresses.token,
      this.getProvider(),
    );
  }

  // ============ MultiCollateral-specific methods ============

  /**
   * Populate cross-chain transfer to a specific target router.
   */
  async populateTransferRemoteToTx(params: {
    destination: Domain;
    recipient: Address;
    amount: Numberish;
    targetRouter: Address;
  }): Promise<PopulatedTransaction> {
    const recipientBytes32 = addressToBytes32(params.recipient);
    const targetRouterBytes32 = addressToBytes32(params.targetRouter);

    // Quote gas
    const quotes = await this.multiCollateralContract.quoteTransferRemoteTo(
      params.destination,
      recipientBytes32,
      params.amount.toString(),
      targetRouterBytes32,
    );
    const nativeGas = quotes[0].amount;

    return this.multiCollateralContract.populateTransaction.transferRemoteTo(
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
    const recipientBytes32 = addressToBytes32(params.recipient);
    const targetRouterBytes32 = addressToBytes32(params.targetRouter);

    const quotes = await this.multiCollateralContract.quoteTransferRemoteTo(
      params.destination,
      recipientBytes32,
      params.amount.toString(),
      targetRouterBytes32,
    );

    const amount = BigInt(params.amount.toString());
    const tokenQuoteAmount = BigInt(quotes[1].amount.toString());
    const externalFeeAmount = BigInt(quotes[2].amount.toString());
    const tokenFeeAmount =
      tokenQuoteAmount >= amount
        ? tokenQuoteAmount - amount + externalFeeAmount
        : externalFeeAmount;

    return {
      igpQuote: { amount: BigInt(quotes[0].amount.toString()) },
      tokenFeeQuote: {
        addressOrDenom: quotes[1].token,
        amount: tokenFeeAmount,
      },
    };
  }
}
