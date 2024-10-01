import { assert } from '@hyperlane-xyz/utils';

// prettier-ignore
// @ts-ignore
import { getSafe, getSafeService } from '../../../../utils/gnosisSafe.js';
import { MultiProvider } from '../../../MultiProvider.js';
import { PopulatedTransactions } from '../../types.js';

import { EV5GnosisSafeTxSubmitter } from './EV5GnosisSafeTxSubmitter.js';
import { EV5GnosisSafeTxBuilderProps } from './types.js';

// This class is used to create ao Safe Transaction Builder compatible file. It is not a true Submitter because it does not submits any transactions.
export class EV5GnosisSafeTxBuilderWriter extends EV5GnosisSafeTxSubmitter {
  private async writeToFile() {}

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
  public async submit(...txs: PopulatedTransactions): Promise<any[]> {
    const safeTransaction = await this.createSafeTransaction(txs);
    console.log('safeTransaction', safeTransaction);
    await this.writeToFile();

    return [];
  }
}
