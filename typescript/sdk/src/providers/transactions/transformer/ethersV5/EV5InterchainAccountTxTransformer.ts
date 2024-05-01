import assert from 'assert';
import { PopulatedTransaction } from 'ethers';
import { Logger } from 'pino';

import { CallData, rootLogger } from '@hyperlane-xyz/utils';

import { chainIdToMetadata } from '../../../../consts/chainMetadata.js';
import { InterchainAccount } from '../../../../middleware/account/InterchainAccount.js';
import { AccountConfig } from '../../../../middleware/account/types.js';
import { ChainName } from '../../../../types.js';
import { MultiProvider } from '../../../MultiProvider.js';
import { EV5Tx } from '../../TransactionTypes.js';
import { TxTransformerType } from '../TxTransformerTypes.js';

import { EV5TxTransformerInterface } from './EV5TxTransformerInterface.js';

interface EV5InterchainAccountTxTransformerProps {
  interchainAccount: InterchainAccount;
  accountConfig: AccountConfig;
  hookMetadata?: string;
}

export class EV5InterchainAccountTxTransformer
  implements EV5TxTransformerInterface
{
  public readonly txTransformerType: TxTransformerType = TxTransformerType.ICA;
  protected readonly logger: Logger = rootLogger.child({
    module: 'ica-transformer',
  });

  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly chain: ChainName,
    public readonly props: EV5InterchainAccountTxTransformerProps,
  ) {}

  public async transform(...txs: EV5Tx[]): Promise<EV5Tx[]> {
    const destinationChainId = txs[0].chainId;
    assert(
      destinationChainId,
      'Missing destination chainId in EthersV5Transaction.',
    );

    const innerCalls: CallData[] = txs.map(
      ({ to, data, value }: PopulatedTransaction) => {
        assert(
          to && data,
          'Invalid EthersV5Transaction: Missing required field to or data.',
        );
        return { to, data, value };
      },
    );

    return [
      await this.props.interchainAccount.getCallRemote(
        this.chain,
        chainIdToMetadata[destinationChainId].name,
        innerCalls,
        this.props.accountConfig,
        this.props.hookMetadata,
      ),
    ];
  }
}
