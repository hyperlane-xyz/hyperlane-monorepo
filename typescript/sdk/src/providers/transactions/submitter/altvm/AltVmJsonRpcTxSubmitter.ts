import { Logger } from 'pino';

import { AltVM, rootLogger } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../../../MultiProvider.js';
import { AnnotatedAltVmTransaction } from '../../../ProviderType.js';
import { TxSubmitterInterface } from '../TxSubmitterInterface.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

export class AltVmJsonRpcTxSubmitter implements TxSubmitterInterface<any> {
  public readonly txSubmitterType: TxSubmitterType = TxSubmitterType.JSON_RPC;

  private signer: AltVM.ISigner;

  protected readonly logger: Logger = rootLogger.child({
    module: AltVmJsonRpcTxSubmitter.name,
  });

  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly altVmSigner: AltVM.ISignerFactory,
    public readonly config: { chain: string },
  ) {
    this.signer = this.altVmSigner.get(this.config.chain);
  }

  public async submit(...txs: AnnotatedAltVmTransaction[]): Promise<any[]> {
    const receipt = await this.signer.signAndBroadcast(
      txs.map((tx) => tx.altvm_tx),
    );
    return receipt;
  }
}
