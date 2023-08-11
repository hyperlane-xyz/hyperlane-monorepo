import {
  ChainName,
  EthersV5Transaction,
  EvmRouterAdapter,
  ProviderType,
  RouterAddress,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { StatCounts } from '../app/types';
import { HelloWorld, HelloWorld__factory } from '../types';

import { IHelloWorldAdapter } from './types';

export class EvmHelloWorldAdapter
  extends EvmRouterAdapter<RouterAddress & { mailbox: Address }>
  implements IHelloWorldAdapter
{
  async populateSendHelloTx(
    from: ChainName,
    to: ChainName,
    message: string,
    value: string,
  ): Promise<EthersV5Transaction> {
    const contract = this.getConnectedContract(from);
    const toDomain = this.multiProvider.getDomainId(to);
    const { transactionOverrides } = this.multiProvider.getChainMetadata(from);

    // apply gas buffer due to https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/634
    const estimated = await contract.estimateGas.sendHelloWorld(
      toDomain,
      message,
      { ...transactionOverrides, value },
    );
    const gasLimit = estimated.mul(12).div(10);

    const tx = await contract.populateTransaction.sendHelloWorld(
      toDomain,
      message,
      {
        ...transactionOverrides,
        gasLimit,
        value,
      },
    );
    return { transaction: tx, type: ProviderType.EthersV5 };
  }

  async channelStats(from: ChainName, to: ChainName): Promise<StatCounts> {
    const fromDomain = this.multiProvider.getDomainId(from);
    const toDomain = this.multiProvider.getDomainId(to);
    const sent = await this.getConnectedContract(from).sentTo(toDomain);
    const received = await this.getConnectedContract(from).sentTo(fromDomain);
    return { sent: sent.toNumber(), received: received.toNumber() };
  }

  override getConnectedContract(chain: ChainName): HelloWorld {
    const address = this.multiProvider.getChainMetadata(chain).router;
    const provider = this.multiProvider.getEthersV5Provider(chain);
    return HelloWorld__factory.connect(address, provider);
  }
}
