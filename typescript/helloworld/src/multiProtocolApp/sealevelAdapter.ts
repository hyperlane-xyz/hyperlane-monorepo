import {
  ChainName,
  ProviderType,
  SealevelRouterAdapter,
  SolanaWeb3Transaction,
} from '@hyperlane-xyz/sdk';

import { StatCounts } from '../app/types';

import { IHelloWorldAdapter } from './types';

export class SealevelHelloWorldAdapter
  extends SealevelRouterAdapter
  implements IHelloWorldAdapter
{
  async populateHelloWorldTx(
    from: ChainName,
    to: ChainName,
    message: string,
    value: string,
  ): Promise<SolanaWeb3Transaction> {
    console.log(
      'Creating sendHelloWorld tx for sealevel',
      from,
      to,
      message,
      value,
    );
    // TODO create tx here
    return { type: ProviderType.SolanaWeb3, transaction: {} as any };
  }

  async channelStats(from: ChainName, _to: ChainName): Promise<StatCounts> {
    const accountInfo = await this.getRouterAccountInfo(from);
    console.log('Account info', accountInfo);
    // TODO extract info here
    return { sent: 0, received: 0 };
  }

  async getAccountInfo(chain: ChainName): Promise<any> {
    const address = this.multiProvider.getChainMetadata(chain).router;
    const connection = this.multiProvider.getSolanaWeb3Provider(chain);

    const msgRecipientPda = this.deriveMessageRecipientPda(address);
    const accountInfo = await connection.getAccountInfo(msgRecipientPda);
    if (!accountInfo)
      throw new Error(
        `No account info found for ${msgRecipientPda.toBase58()}}`,
      );
    // TODO deserialize data correctly
    // const accountData = deserializeUnchecked( {}, {}, accountInfo.data);
    return {};
  }
}
