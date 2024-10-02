import { assert } from '@hyperlane-xyz/utils';

// prettier-ignore
// @ts-ignore
import { getSafe, getSafeService } from '../../../../utils/gnosisSafe.js';
import { MultiProvider } from '../../../MultiProvider.js';
import { PopulatedTransaction, PopulatedTransactions } from '../../types.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

import { EV5GnosisSafeTxSubmitter } from './EV5GnosisSafeTxSubmitter.js';
import { EV5GnosisSafeTxBuilderProps } from './types.js';

// This class is used to create ao Safe Transaction Builder compatible file.
// It is not a true Submitter because it does not submits any transactions.
export class EV5GnosisSafeTxBuilderWriter extends EV5GnosisSafeTxSubmitter {
  public readonly txSubmitterType: TxSubmitterType =
    TxSubmitterType.GNOSIS_TX_BUILDER;
  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly props: EV5GnosisSafeTxBuilderProps,
    safe: any,
    safeService: any,
  ) {
    super(multiProvider, props, safe, safeService);
  }

  static async create(
    multiProvider: MultiProvider,
    props: EV5GnosisSafeTxBuilderProps,
  ): Promise<EV5GnosisSafeTxBuilderWriter> {
    const { chain, safeAddress } = props;
    const { gnosisSafeTransactionServiceUrl } =
      multiProvider.getChainMetadata(chain);
    assert(
      gnosisSafeTransactionServiceUrl,
      `Must set gnosisSafeTransactionServiceUrl in the Registry metadata for ${chain}`,
    );
    const safe = await getSafe(chain, multiProvider, safeAddress);
    const safeService = await getSafeService(chain, multiProvider);

    return new EV5GnosisSafeTxBuilderWriter(
      multiProvider,
      props,
      safe,
      safeService,
    );
  }
  public async submit(...txs: PopulatedTransactions): Promise<any> {
    const transactions = await Promise.all(
      txs.map(
        async (tx: PopulatedTransaction) =>
          (
            await this.createSafeTransaction(tx)
          ).data,
      ),
    );
    return {
      version: this.props.version,
      chainId: this.multiProvider.getChainId(this.props.chain).toString(),
      meta: this.props.meta,
      transactions,
    };
  }
}
