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
    origin: ChainName,
    destination: ChainName,
    message: string,
    value: string,
  ): Promise<EthersV5Transaction> {
    const contract = this.getConnectedContract(origin);
    const toDomain = this.multiProvider.getDomainId(destination);
    const { transactionOverrides } =
      this.multiProvider.getChainMetadata(origin);

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

  async channelStats(
    origin: ChainName,
    destination: ChainName,
  ): Promise<StatCounts> {
    const fromDomain = this.multiProvider.getDomainId(origin);
    const toDomain = this.multiProvider.getDomainId(destination);
    const sent = await this.getConnectedContract(origin).sentTo(toDomain);
    const received = await this.getConnectedContract(origin).sentTo(fromDomain);
    return { sent: sent.toNumber(), received: received.toNumber() };
  }

  override getConnectedContract(chain: ChainName): HelloWorld {
    const address = this.multiProvider.getChainMetadata(chain).router;
    const provider = this.multiProvider.getEthersV5Provider(chain);
    return HelloWorld__factory.connect(address, provider);
  }
}
