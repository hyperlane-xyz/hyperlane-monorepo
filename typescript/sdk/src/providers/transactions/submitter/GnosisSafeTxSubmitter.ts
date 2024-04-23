import { Logger } from 'pino';

import { rootLogger } from '@hyperlane-xyz/utils';

import { GnosisSafeHyperlaneTx } from '../GnosisSafeHyperlaneTx.js';
import { HyperlaneTxReceipt } from '../HyperlaneTxReceipt.js';
import { InterchainAccountHyperlaneTx } from '../InterchainAccountHyperlaneTx.js';

import { TxSubmitterInterface, TxSubmitterType } from './TxSubmitter.js';

export class GnosisSafeTxSubmitter
  implements
    TxSubmitterInterface<
      GnosisSafeHyperlaneTx | InterchainAccountHyperlaneTx,
      HyperlaneTxReceipt
    >
{
  public readonly txSubmitterType: TxSubmitterType =
    TxSubmitterType.GNOSIS_SAFE;
  protected readonly logger: Logger = rootLogger.child({
    module: 'transactions',
  });

  public async submitTxs(
    hyperlaneTxs: GnosisSafeHyperlaneTx[],
  ): Promise<HyperlaneTxReceipt[]> {
    const hyperlaneReceipts: HyperlaneTxReceipt[] = [];
    for (const hyperlaneTx of hyperlaneTxs) {
      const receipt = await this.submitTx(hyperlaneTx);
      hyperlaneReceipts.push(receipt);
    }
    return hyperlaneReceipts;
  }

  public async submitTx(
    hyperlaneTx: GnosisSafeHyperlaneTx,
  ): Promise<HyperlaneTxReceipt> {
    await hyperlaneTx.safeService.proposeTransaction({
      safeAddress: hyperlaneTx.safeAddress,
      safeTransactionData: hyperlaneTx.safeTransactionData,
      safeTxHash: hyperlaneTx.safeTxHash,
      senderAddress: hyperlaneTx.senderAddress,
      senderSignature: hyperlaneTx.senderSignature,
    });

    this.logger.debug(
      `Submitted GnosisSafeHyperlaneTx to ${hyperlaneTx.safeAddress} on ${hyperlaneTx.chain}: ${hyperlaneTx.safeTxHash}`,
    );
  }
}
