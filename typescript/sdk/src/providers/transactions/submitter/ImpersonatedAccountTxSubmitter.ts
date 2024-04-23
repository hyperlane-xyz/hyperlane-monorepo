import { ContractReceipt } from 'ethers';
import { Logger } from 'pino';

import { impersonateAccount } from '@hyperlane-xyz/sdk';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { ChainNameOrId } from '../../../types.js';
import { MultiProvider } from '../../MultiProvider.js';
import { HyperlaneTxReceipt } from '../HyperlaneTxReceipt.js';
import { ImpersonatedAccountHyperlaneTx } from '../ImpersonatedAccountHyperlaneTx.js';

import { TxSubmitterInterface, TxSubmitterType } from './TxSubmitter.js';

export class ImpersonatedAccountTxSubmitter
  implements
    TxSubmitterInterface<ImpersonatedAccountHyperlaneTx, HyperlaneTxReceipt>
{
  public readonly txSubmitterType: TxSubmitterType =
    TxSubmitterType.IMPERSONATED_ACCOUNT;
  protected readonly logger: Logger = rootLogger.child({
    module: 'transactions',
  });

  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly chain: ChainNameOrId,
    public readonly userEOA: Address,
  ) {
    this.multiProvider = multiProvider;
    this.chain = chain;
    this.userEOA = userEOA;
  }

  public async submitTxs(
    hyperlaneTxs: ImpersonatedAccountHyperlaneTx[],
  ): Promise<HyperlaneTxReceipt[]> {
    const hyperlaneReceipts: HyperlaneTxReceipt[] = [];
    for (const hyperlaneTx of hyperlaneTxs) {
      const receipt = await this.submitTx(hyperlaneTx);
      hyperlaneReceipts.push(receipt);
    }
    return hyperlaneReceipts;
  }

  public async submitTx(
    hyperlaneTx: ImpersonatedAccountHyperlaneTx,
  ): Promise<HyperlaneTxReceipt> {
    const signer = await impersonateAccount(this.userEOA);
    this.multiProvider.setSigner(this.chain, signer);
    const receipt: ContractReceipt = await this.multiProvider.sendTransaction(
      this.chain,
      hyperlaneTx.populatedTx,
    );

    this.logger.debug(
      `Submitted ImpersonatedAccountHyperlaneTx on ${this.chain}: ${receipt.transactionHash}`,
    );

    return receipt;
  }
}
