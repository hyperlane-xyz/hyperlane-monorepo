import { ContractReceipt } from 'ethers';
import { Logger } from 'pino';

import { rootLogger } from '@hyperlane-xyz/utils';
import { Address } from '@hyperlane-xyz/utils';

import { ChainName } from '../../../../types.js';
import { impersonateAccount } from '../../../../utils/fork.js';
import { MultiProvider } from '../../../MultiProvider.js';
import {
  EthersV5Transaction,
  EthersV5TransactionReceipt,
  ProviderType,
} from '../../../ProviderType.js';
import { TxSubmitterInterface } from '../TxSubmitterInterface.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

interface ImpersonatedAccountTxSubmitterProps {
  address: Address;
}

export class ImpersonatedAccountTxSubmitter
  implements
    TxSubmitterInterface<EthersV5Transaction, EthersV5TransactionReceipt>
{
  public readonly txSubmitterType: TxSubmitterType =
    TxSubmitterType.IMPERSONATED_ACCOUNT;

  protected readonly logger: Logger = rootLogger.child({
    module: 'impersonated-account-submitter',
  });

  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly chain: ChainName,
    public readonly props: ImpersonatedAccountTxSubmitterProps,
  ) {}

  public async submit(
    ...txs: EthersV5Transaction[]
  ): Promise<EthersV5TransactionReceipt[]> {
    const receipts: EthersV5TransactionReceipt[] = [];
    for (const tx of txs) {
      const signer = await impersonateAccount(this.props.address);
      this.multiProvider.setSigner(this.chain, signer);
      const receipt: ContractReceipt = await this.multiProvider.sendTransaction(
        this.chain,
        tx.transaction,
      );

      this.logger.debug(
        `Submitted EthersV5Transaction on ${this.chain}: ${receipt.transactionHash}`,
      );

      receipts.push({ type: ProviderType.EthersV5, receipt });
    }
    return receipts;
  }
}
