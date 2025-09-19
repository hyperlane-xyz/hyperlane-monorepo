import { DeliverTxResponse } from '@cosmjs/stargate';
import { Logger } from 'pino';

import { ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { IMultiProtocolSignerManager } from '../../../../types.js';
import { MultiProvider } from '../../../MultiProvider.js';
import { AnnotatedCosmJsNativeTransaction } from '../../../ProviderType.js';
import { TxSubmitterInterface } from '../TxSubmitterInterface.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

export class CosmosNativeRpcTxSubmitter
  implements TxSubmitterInterface<ProtocolType.CosmosNative>
{
  public readonly txSubmitterType: TxSubmitterType = TxSubmitterType.JSON_RPC;

  protected readonly logger: Logger = rootLogger.child({
    module: 'json-rpc-submitter',
  });

  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly multiProtocolSigner: IMultiProtocolSignerManager,
    public readonly props: { chain: string },
  ) {}

  public async submit(
    ...txs: AnnotatedCosmJsNativeTransaction[]
  ): Promise<DeliverTxResponse[]> {
    const signer = this.multiProtocolSigner.getCosmosNativeSigner(
      this.props.chain,
    );

    const receipt = await signer.signAndBroadcast(
      signer.account.address,
      txs,
      2,
    );
    return [receipt];
  }
}
