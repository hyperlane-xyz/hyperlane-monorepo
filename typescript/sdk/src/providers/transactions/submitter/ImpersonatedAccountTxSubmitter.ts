import { ContractReceipt } from 'ethers';
import { Logger } from 'pino';

import { impersonateAccount } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { ChainName } from '../../../types.js';
import { MultiProvider } from '../../MultiProvider.js';
import { HyperlaneTx } from '../HyperlaneTx.js';
import { HyperlaneTxReceipt } from '../HyperlaneTxReceipt.js';

import { TxSubmitterInterface } from './TxSubmitter.js';
import {
  ImpersonatedAccountTxSubmitterProps,
  TxSubmitterType,
} from './TxSubmitterTypes.js';

export class ImpersonatedAccountTxSubmitter<
  HTX extends HyperlaneTx,
  HTR extends HyperlaneTxReceipt,
> implements TxSubmitterInterface<HTX, HTR>
{
  public readonly txSubmitterType: TxSubmitterType =
    TxSubmitterType.IMPERSONATED_ACCOUNT;

  protected readonly logger: Logger = rootLogger.child({
    module: 'transactions',
  });

  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly chain: ChainName,
    public readonly props: ImpersonatedAccountTxSubmitterProps,
  ) {
    this.multiProvider = multiProvider;
    this.chain = chain;
    this.props = props;
  }

  public async submitTxs(hyperlaneTxs: HTX[]): Promise<HTR[]> {
    const hyperlaneReceipts: HTR[] = [];
    for (const hyperlaneTx of hyperlaneTxs) {
      const receipt = await this.submitTx(hyperlaneTx);
      hyperlaneReceipts.push(receipt);
    }
    return hyperlaneReceipts;
  }

  public async submitTx(hyperlaneTx: HTX): Promise<HTR> {
    const signer = await impersonateAccount(this.props.userEOA);
    this.multiProvider.setSigner(this.chain, signer);
    const receipt: ContractReceipt = await this.multiProvider.sendTransaction(
      this.chain,
      hyperlaneTx,
    );

    this.logger.debug(
      `Submitted HyperlaneTx on ${this.chain}: ${receipt.transactionHash}`,
    );

    return receipt as HTR;
  }
}
