import SafeApiKit from '@safe-global/api-kit';
import Safe from '@safe-global/protocol-kit';
import { SafeTransactionData } from '@safe-global/safe-core-sdk-types';

import { MultiProvider } from '../../../MultiProvider.js';
import { AnnotatedEvmTransaction } from '../../../ProviderType.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

import { EvmGnosisSafeTxSubmitter } from './EvmGnosisSafeTxSubmitter.js';
import { EvmGnosisSafeTxBuilderProps } from './types.js';

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
export class EvmGnosisSafeTxBuilder extends EvmGnosisSafeTxSubmitter {
  public readonly txSubmitterType: TxSubmitterType =
    TxSubmitterType.GNOSIS_TX_BUILDER;

  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly props: EvmGnosisSafeTxBuilderProps,
    safe: Safe.default,
    safeService: SafeApiKit.default,
  ) {
    super(multiProvider, props, safe, safeService);
  }

  static async create(
    multiProvider: MultiProvider,
    props: EvmGnosisSafeTxBuilderProps,
  ): Promise<EvmGnosisSafeTxBuilder> {
    const { chain, safeAddress } = props;
    const { safe, safeService } =
      await EvmGnosisSafeTxSubmitter.initSafeAndService(
        chain,
        multiProvider,
        safeAddress,
      );
    return new EvmGnosisSafeTxBuilder(multiProvider, props, safe, safeService);
  }

  // No requirement to get the next nonce from the Safe service.
  // When proposing the JSON file, the Safe UI will automatically update the nonce.
  // So we just return 0 and save ourselves from the unreliability of Safe APIs.
  protected async getNextNonce(): Promise<number> {
    return 0;
  }

  /**
   * Creates a Gnosis Safe transaction builder object using the PopulatedTransactions
   *
   * @param txs - An array of populated transactions
   */
  public async submit(...txs: AnnotatedEvmTransaction[]): Promise<any> {
    const chainId = this.multiProvider.getChainId(this.props.chain);
    const transactions: SafeTransactionData[] = await Promise.all(
      txs.map(
        async (tx: AnnotatedEvmTransaction) =>
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
