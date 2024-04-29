import assert from 'assert';
import { Logger } from 'pino';

import { CallData, rootLogger } from '@hyperlane-xyz/utils';

import { chainIdToMetadata } from '../../../../consts/chainMetadata.js';
import { InterchainAccount } from '../../../../middleware/account/InterchainAccount.js';
import { AccountConfig } from '../../../../middleware/account/types.js';
import { ChainName } from '../../../../types.js';
import { MultiProvider } from '../../../MultiProvider.js';
import { EthersV5Transaction, ProviderType } from '../../../ProviderType.js';
import { TxTransformerInterface } from '../TxTransformer.js';
import { TxTransformerType } from '../TxTransformerTypes.js';

interface InterchainAccountTxTransformerProps {
  interchainAccount: InterchainAccount;
  accountConfig: AccountConfig;
  hookMetadata?: string;
}

export class InterchainAccountTxTransformer
  implements TxTransformerInterface<EthersV5Transaction>
{
  public readonly txTransformerType: TxTransformerType = TxTransformerType.ICA;
  protected readonly logger: Logger = rootLogger.child({
    module: 'ica-transformer',
  });

  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly chain: ChainName,
    public readonly props: InterchainAccountTxTransformerProps,
  ) {}

  public async transformTxs(
    txs: EthersV5Transaction[],
  ): Promise<EthersV5Transaction[]> {
    const destinationChainId = txs[0].transaction.chainId;
    assert(
      destinationChainId,
      'Missing destination chainId in EthersV5Transaction.',
    );

    const innerCalls: CallData[] = txs.map(
      ({ transaction }: EthersV5Transaction) => {
        const { to, data, value } = transaction;
        assert(
          to && data,
          'Invalid EthersV5Transaction: Missing required metadata.',
        );
        return { to, data, value };
      },
    );

    const transaction = await this.props.interchainAccount.getCallRemote(
      this.chain,
      chainIdToMetadata[destinationChainId].name,
      innerCalls,
      this.props.accountConfig,
      this.props.hookMetadata,
    );

    return [{ type: ProviderType.EthersV5, transaction }];
  }
}
