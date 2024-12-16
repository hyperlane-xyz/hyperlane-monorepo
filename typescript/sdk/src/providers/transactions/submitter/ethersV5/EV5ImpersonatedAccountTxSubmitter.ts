import { TransactionReceipt } from '@ethersproject/providers';
import { Logger } from 'pino';

import { rootLogger } from '@hyperlane-xyz/utils';

import {
  impersonateAccount,
  stopImpersonatingAccount,
} from '../../../../utils/fork.js';
import { MultiProvider } from '../../../MultiProvider.js';
import { AnnotatedEV5Transaction } from '../../../ProviderType.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

import { EV5JsonRpcTxSubmitter } from './EV5JsonRpcTxSubmitter.js';
import { EV5ImpersonatedAccountTxSubmitterProps } from './types.js';

export class EV5ImpersonatedAccountTxSubmitter extends EV5JsonRpcTxSubmitter {
  public readonly txSubmitterType = TxSubmitterType.IMPERSONATED_ACCOUNT;

  protected readonly logger: Logger = rootLogger.child({
    module: 'impersonated-account-submitter',
  });

  constructor(
    multiProvider: MultiProvider,
    public readonly props: EV5ImpersonatedAccountTxSubmitterProps,
  ) {
    super(multiProvider, props);
  }

  public async submit(
    ...txs: AnnotatedEV5Transaction[]
  ): Promise<TransactionReceipt[]> {
    const provider = this.multiProvider.jsonRpcProvider(this.props.chain);
    const impersonatedAccount = await impersonateAccount(
      provider,
      this.props.userAddress,
    );
    this.multiProvider.setSigner(this.props.chain, impersonatedAccount);
    const transactionReceipts = await super.submit(...txs);
    await stopImpersonatingAccount(provider, this.props.userAddress);
    return transactionReceipts;
  }
}
