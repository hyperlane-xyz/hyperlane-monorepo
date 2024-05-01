import { ContractReceipt } from 'ethers';
import { Logger } from 'pino';

import { rootLogger } from '@hyperlane-xyz/utils';
import { Address } from '@hyperlane-xyz/utils';

import { ChainName } from '../../../../types.js';
import { impersonateAccount } from '../../../../utils/fork.js';
import { MultiProvider } from '../../../MultiProvider.js';
import { EV5Receipt, EV5Tx } from '../../TransactionTypes.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

import { EV5TxSubmitterInterface } from './EV5TxSubmitterInterface.js';

interface EV5ImpersonatedAccountTxSubmitterProps {
  address: Address;
}

export class EV5ImpersonatedAccountTxSubmitter
  implements EV5TxSubmitterInterface
{
  public readonly txSubmitterType: TxSubmitterType =
    TxSubmitterType.IMPERSONATED_ACCOUNT;

  protected readonly logger: Logger = rootLogger.child({
    module: 'impersonated-account-submitter',
  });

  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly chain: ChainName,
    public readonly props: EV5ImpersonatedAccountTxSubmitterProps,
  ) {}

  public async submit(...txs: EV5Tx[]): Promise<EV5Receipt[]> {
    const receipts: EV5Receipt[] = [];
    for (const tx of txs) {
      const signer = await impersonateAccount(this.props.address);
      this.multiProvider.setSigner(this.chain, signer);
      const receipt: ContractReceipt = await this.multiProvider.sendTransaction(
        this.chain,
        tx,
      );

      this.logger.debug(
        `Submitted EthersV5Transaction on ${this.chain}: ${receipt.transactionHash}`,
      );

      receipts.push(receipt);
    }
    return receipts;
  }
}
