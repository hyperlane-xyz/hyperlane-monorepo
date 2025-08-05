import { SafeTransactionData } from '@safe-global/safe-core-sdk-types';

import { assert } from '@hyperlane-xyz/utils';

// prettier-ignore
// @ts-ignore
import { getSafe, getSafeService } from '../../../../utils/gnosisSafe.js';
import { MultiProvider } from '../../../MultiProvider.js';
import { AnnotatedEV5Transaction } from '../../../ProviderType.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

import { EV5GnosisSafeTxSubmitter } from './EV5GnosisSafeTxSubmitter.js';
import { EV5GnosisSafeTxBuilderProps } from './types.js';

// TODO: Use this return type in submit()
export interface GnosisTransactionBuilderPayload {
  version: string;
  chainId: string;
  meta: {};
  transactions: SafeTransactionData[];
}

/**
 * This class is used to create a Safe Transaction Builder compatible object.
 * It is not a true Submitter because it does not submits any transactions.
 */
export class EV5GnosisSafeTxBuilder extends EV5GnosisSafeTxSubmitter {
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
  ): Promise<EV5GnosisSafeTxBuilder> {
    const { chain, safeAddress } = props;
    const { gnosisSafeTransactionServiceUrl } =
      multiProvider.getChainMetadata(chain);
    assert(
      gnosisSafeTransactionServiceUrl,
      `Must set gnosisSafeTransactionServiceUrl in the Registry metadata for ${chain}`,
    );
    const safe = await getSafe(chain, multiProvider, safeAddress);
    const safeService = await getSafeService(chain, multiProvider);

    return new EV5GnosisSafeTxBuilder(multiProvider, props, safe, safeService);
  }

  /**
   * Creates a Gnosis Safe transaction builder object using the PopulatedTransactions
   *
   * @param txs - An array of populated transactions
   */
  public async submit(...txs: AnnotatedEV5Transaction[]): Promise<any> {
    const chainId = this.multiProvider.getChainId(this.props.chain);
    const transactions: SafeTransactionData[] = await Promise.all(
      txs.map(
        async (tx: AnnotatedEV5Transaction) =>
          (await this.createSafeTransaction(tx)).data,
      ),
    );
    return {
      version: this.props.version,
      chainId: chainId.toString(),
      meta: {},
      transactions,
    };
  }
}
