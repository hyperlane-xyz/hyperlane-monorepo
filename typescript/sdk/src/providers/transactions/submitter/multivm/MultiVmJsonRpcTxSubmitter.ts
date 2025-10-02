import { Logger } from 'pino';

import { MultiVM, rootLogger } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../../../MultiProvider.js';
import { AnnotatedMultiVmTransaction } from '../../../ProviderType.js';
import { TxSubmitterInterface } from '../TxSubmitterInterface.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

export class MultiVmJsonRpcTxSubmitter implements TxSubmitterInterface<any> {
  public readonly txSubmitterType: TxSubmitterType = TxSubmitterType.JSON_RPC;

  private signer: MultiVM.ISigner;

  protected readonly logger: Logger = rootLogger.child({
    module: MultiVmJsonRpcTxSubmitter.name,
  });

  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly multiVmSigners: MultiVM.ISignerFactory,
    public readonly config: { chain: string },
  ) {
    this.signer = this.multiVmSigners.get(this.config.chain);
  }

  public async submit(...txs: AnnotatedMultiVmTransaction[]): Promise<any[]> {
    const receipt = await this.signer.signAndBroadcast(
      txs.map((tx) => tx.transaction),
    );
    return receipt;
  }
}
