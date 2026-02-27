import { TransactionReceipt } from 'ethers';
import { Logger } from 'pino';

import { rootLogger } from '@hyperlane-xyz/utils';

import {
  impersonateAccount,
  stopImpersonatingAccount,
} from '../../../../utils/fork.js';
import { MultiProvider } from '../../../MultiProvider.js';
import { AnnotatedEvmTransaction } from '../../../ProviderType.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

import { EvmJsonRpcTxSubmitter } from './EvmJsonRpcTxSubmitter.js';
import { EvmImpersonatedAccountTxSubmitterProps } from './types.js';

export class EvmImpersonatedAccountTxSubmitter extends EvmJsonRpcTxSubmitter {
  public readonly txSubmitterType: TxSubmitterType =
    TxSubmitterType.IMPERSONATED_ACCOUNT;

  protected readonly logger: Logger = rootLogger.child({
    module: 'impersonated-account-submitter',
  });

  constructor(
    multiProvider: MultiProvider,
    public readonly props: EvmImpersonatedAccountTxSubmitterProps,
  ) {
    super(multiProvider, props);
  }

  public async submit(
    ...txs: AnnotatedEvmTransaction[]
  ): Promise<TransactionReceipt[]> {
    // It is assumed that this Submitter will be used by setting the registry url to the anvil endpoint
    const anvilEndpoint = this.multiProvider.getChainMetadata(this.props.chain)
      ?.rpcUrls[0].http;
    const impersonatedAccount = await impersonateAccount(
      this.props.userAddress,
      anvilEndpoint,
    );
    this.multiProvider.setSharedSigner(impersonatedAccount);
    const transactionReceipts = await super.submit(...txs);
    await stopImpersonatingAccount(this.props.userAddress, anvilEndpoint);
    return transactionReceipts;
  }
}
