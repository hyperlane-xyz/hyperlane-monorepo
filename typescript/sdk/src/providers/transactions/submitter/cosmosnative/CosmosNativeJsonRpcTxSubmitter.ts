import { DeliverTxResponse } from '@cosmjs/stargate';
import { Logger } from 'pino';

import { MultiVM, ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { IMultiVMSignerFactory } from '../../../../../../utils/dist/multivm.js';
import { MultiProvider } from '../../../MultiProvider.js';
import { AnnotatedCosmJsNativeTransaction } from '../../../ProviderType.js';
import { TxSubmitterInterface } from '../TxSubmitterInterface.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

export class CosmosNativeRpcTxSubmitter
  implements TxSubmitterInterface<ProtocolType.CosmosNative>
{
  public readonly txSubmitterType: TxSubmitterType = TxSubmitterType.JSON_RPC;

  private signer: MultiVM.IMultiVMSigner;

  protected readonly logger: Logger = rootLogger.child({
    module: CosmosNativeRpcTxSubmitter.name,
  });

  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly multiVmSigners: IMultiVMSignerFactory,
    public readonly config: { chain: string },
  ) {
    this.signer = this.multiVmSigners.get(this.config.chain);
  }

  public async submit(
    ...txs: AnnotatedCosmJsNativeTransaction[]
  ): Promise<DeliverTxResponse[]> {
    const receipt = await this.signer.signAndBroadcast(txs);
    return receipt;
  }
}
