import { DeliverTxResponse } from '@cosmjs/stargate';
import { Logger } from 'pino';

import { SigningHyperlaneModuleClient } from '@hyperlane-xyz/cosmos-sdk';
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

  private signer: SigningHyperlaneModuleClient;

  protected readonly logger: Logger = rootLogger.child({
    module: CosmosNativeRpcTxSubmitter.name,
  });

  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly multiProtocolSigner: IMultiProtocolSignerManager,
    public readonly config: { chain: string },
  ) {
    this.signer = this.multiProtocolSigner.getCosmosNativeSigner(
      this.config.chain,
    );
  }

  public async submit(
    ...txs: AnnotatedCosmJsNativeTransaction[]
  ): Promise<DeliverTxResponse[]> {
    const receipt = await this.signer.signAndBroadcast(
      this.signer.account.address,
      txs,
      2,
    );
    return [receipt];
  }
}
