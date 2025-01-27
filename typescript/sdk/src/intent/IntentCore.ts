import { Address as ViemAddress } from 'viem';

import { Address, assert } from '@hyperlane-xyz/utils';

import { TokenAmount } from '../token/TokenAmount.js';
import { TOKEN_STANDARD_TO_PROVIDER_TYPE } from '../token/TokenStandard.js';
import { ChainNameOrId } from '../types.js';
import { WarpCore } from '../warp/WarpCore.js';
import { WarpTxCategory, WarpTypedTransaction } from '../warp/types.js';

const DEFAULT_FILL_DEADLINE = Math.floor(Date.now() / 1000) + 60 * 5;

export class IntentCore extends WarpCore {
  /**
   * Gets a list of populated transactions required to transfer a token to a remote chain
   * Typically just 1 transaction but sometimes more, like when an approval is required first
   */
  async getTransferRemoteTxs({
    originTokenAmount,
    destination,
    sender,
    recipient,
    interchainFee,
    fillDeadline = DEFAULT_FILL_DEADLINE,
  }: {
    originTokenAmount: TokenAmount;
    destination: ChainNameOrId;
    sender: Address;
    recipient: Address;
    interchainFee?: TokenAmount;
    fillDeadline?: number;
  }): Promise<Array<WarpTypedTransaction>> {
    const transactions: Array<WarpTypedTransaction> = [];

    const { token, amount } = originTokenAmount;
    const destinationDomainId = this.multiProvider.getDomainId(destination);
    const providerType = TOKEN_STANDARD_TO_PROVIDER_TYPE[token.standard];
    const adapter = token.getAdapter(this.multiProvider);

    if (await this.isApproveRequired({ originTokenAmount, owner: sender })) {
      this.logger.info(`Approval required for transfer of ${token.symbol}`);

      assert(token.intentRouterAddressOrDenom, 'No intent router found');
      const approveTxReq = await adapter.populateApproveTx({
        weiAmountOrId: amount.toString(),
        recipient: token.intentRouterAddressOrDenom,
      });
      this.logger.debug(`Approval tx for ${token.symbol} populated`);

      const approveTx = {
        category: WarpTxCategory.Approval,
        type: providerType,
        transaction: approveTxReq,
      } as WarpTypedTransaction;
      transactions.push(approveTx);
    }

    if (!interchainFee) {
      interchainFee = await this.getInterchainTransferFee({
        originToken: token,
        destination,
        sender,
      });
    }

    const transferTxReq = await adapter.populateTransferTx({
      weiAmountOrId: amount.toString(),
      recipient,
      intentData: {
        sender: sender as ViemAddress,
        outputToken: token
          .getConnections()
          .find((c) => c.token.chainName === destination)!.token
          .addressOrDenom as ViemAddress,
        amountOut: amount.toString(),
        destinationDomain: destinationDomainId,
        fillDeadline,
      },
    });

    this.logger.debug(`Intent transfer tx for ${token.symbol} populated`);

    const transferTx = {
      category: WarpTxCategory.Transfer,
      type: providerType,
      transaction: transferTxReq,
    } as WarpTypedTransaction;
    transactions.push(transferTx);

    return transactions;
  }

  /**
   * Checks if destination chain's collateral is sufficient to cover the transfer
   */
  async isDestinationCollateralSufficient(): Promise<boolean> {
    return true;
  }
}
