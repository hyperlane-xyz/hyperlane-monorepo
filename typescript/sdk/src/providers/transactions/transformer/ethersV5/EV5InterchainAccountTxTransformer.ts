import { PopulatedTransaction } from 'ethers';
import { Logger } from 'pino';

import { CallData, assert, rootLogger } from '@hyperlane-xyz/utils';

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
    public readonly props: EV5InterchainAccountTxTransformerProps,
  ) {}

  public async transform(
    ...txs: PopulatedTransaction[]
  ): Promise<PopulatedTransaction[]> {
    const innerCalls: CallData[] = txs.map(
      ({ to, data, value, chainId }: PopulatedTransaction) => {
        assert(to, 'Invalid PopulatedTransaction: Missing to field');
        assert(data, 'Invalid PopulatedTransaction: Missing data field');
        assert(chainId, 'Invalid PopulatedTransaction: Missing chainId field');
        const txChain = this.multiProvider.getChainName(chainId);
        assert(
          txChain === this.props.chain,
          `Invalid PopulatedTransaction: Cannot submit ${txChain} tx to ${this.props.chain} submitter.`,
        );
        return { to, data, value };
      },
    );

    return [
      await this.props.interchainAccount.getCallRemote(
        this.props.chain,
        this.multiProvider.getChainName(txs[0].chainId!),
        innerCalls,
        this.props.accountConfig,
        this.props.hookMetadata,
      ),
    ];
  }
}
