import { BigNumber, ethers } from 'ethers';

import {
  ChainName,
  EthersV5Transaction,
  EvmRouterAdapter,
  MultiProtocolProvider,
  ProviderType,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { HelloWorld, HelloWorld__factory } from '../types/index.js';

import { IHelloWorldAdapter } from './types.js';

export class EvmHelloWorldAdapter
  extends EvmRouterAdapter
  implements IHelloWorldAdapter
{
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { router: Address; mailbox: Address },
  ) {
    super(chainName, multiProvider, addresses);
  }

  async populateSendHelloTx(
    destination: ChainName,
    message: string,
    value: string,
    sender: Address,
  ): Promise<EthersV5Transaction> {
    const contract = this.getConnectedContract();
    const toDomain = this.multiProvider.getDomainId(destination);
    const { transactionOverrides } = this.multiProvider.getChainMetadata(
      this.chainName,
    );

    const quote = await contract.callStatic.quoteDispatch(
      toDomain,
      ethers.utils.toUtf8Bytes(message),
    );
    // apply gas buffer due to https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/634
    const estimated = await contract.estimateGas.sendHelloWorld(
      toDomain,
      message,
      {
        ...transactionOverrides,
        // Some networks, like PolygonZkEvm, require a `from` address
        // with funds to be specified when estimating gas for a transaction
        // that provides non-zero `value`.
        from: sender,
        value: BigNumber.from(value).add(quote),
      },
    );
    const gasLimit = estimated.mul(12).div(10);

    const tx = await contract.populateTransaction.sendHelloWorld(
      toDomain,
      message,
      {
        ...transactionOverrides,
        gasLimit,
        value: BigNumber.from(value).add(quote),
      },
    );
    return { transaction: tx, type: ProviderType.EthersV5 };
  }

  async sentStat(destination: ChainName): Promise<number> {
    const destinationDomain = this.multiProvider.getDomainId(destination);
    const originContract = this.getConnectedContract();
    const sent = await originContract.sentTo(destinationDomain);
    return sent.toNumber();
  }

  override getConnectedContract(): HelloWorld {
    return HelloWorld__factory.connect(
      this.addresses.router,
      this.getProvider(),
    );
  }
}
