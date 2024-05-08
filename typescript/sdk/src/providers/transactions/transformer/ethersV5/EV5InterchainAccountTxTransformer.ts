import { PopulatedTransaction } from 'ethers';
import { Logger } from 'pino';

import { CallData, assert, rootLogger } from '@hyperlane-xyz/utils';

import { ChainName } from '../../../../types.js';
import { MultiProvider } from '../../../MultiProvider.js';
import {
  EV5InterchainAccountTxTransformerProps,
  TxTransformerType,
} from '../TxTransformerTypes.js';

import { EV5TxTransformerInterface } from './EV5TxTransformerInterface.js';

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

  public async transform(
    ...txs: PopulatedTransaction[]
  ): Promise<PopulatedTransaction[]> {
    const destinationChainId = txs[0].chainId;
    assert(
      destinationChainId,
      'Missing destination chainId in PopulatedTransaction.',
    );

    const innerCalls: CallData[] = txs.map(
      ({ to, data, value }: PopulatedTransaction) => {
        assert(to, 'Invalid PopulatedTransaction: Missing to field');
        assert(data, 'Invalid PopulatedTransaction: Missing data field');
        return { to, data, value };
      },
    );

    return [
      await this.props.interchainAccount.getCallRemote(
        this.chain,
        this.multiProvider.getChainName(this.chain), //chainIdToMetadata[destinationChainId].name,
        innerCalls,
        this.props.accountConfig,
        this.props.hookMetadata,
      ),
    ];
  }
}
