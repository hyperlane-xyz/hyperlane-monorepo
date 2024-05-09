import { TransactionReceipt } from '@ethersproject/providers';
import { PopulatedTransaction } from 'ethers';
import { Logger } from 'pino';

import { rootLogger } from '@hyperlane-xyz/utils';

import { impersonateAccount } from '../../../../utils/fork.js';
import { MultiProvider } from '../../../MultiProvider.js';
import {
  EV5ImpersonatedAccountTxSubmitterProps,
  TxSubmitterType,
} from '../TxSubmitterTypes.js';

import { EV5JsonRpcTxSubmitter } from './EV5JsonRpcTxSubmitter.js';

export class EV5ImpersonatedAccountTxSubmitter extends EV5JsonRpcTxSubmitter {
  public readonly txSubmitterType: TxSubmitterType =
    TxSubmitterType.IMPERSONATED_ACCOUNT;

  protected readonly logger: Logger = rootLogger.child({
    module: 'impersonated-account-submitter',
  });

  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly props: EV5ImpersonatedAccountTxSubmitterProps,
  ) {
    super(multiProvider);
  }

  public async submit(
    ...txs: PopulatedTransaction[]
  ): Promise<TransactionReceipt[]> {
    const impersonatedAccount = await impersonateAccount(this.props.address);
    this.multiProvider.setSharedSigner(impersonatedAccount);
    super.multiProvider.setSharedSigner(impersonatedAccount);
    return await super.submit(...txs);
  }
}
