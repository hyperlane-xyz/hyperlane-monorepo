import { toBytes } from 'viem';

import {
  ChainName,
  EvmTransaction,
  EvmRouterAdapter,
  MultiProtocolProvider,
  ProviderType,
} from '@hyperlane-xyz/sdk';
import { Address, addBufferToGasLimit, toBigInt } from '@hyperlane-xyz/utils';

import { HelloWorld__factory } from '../app/helloWorldFactory.js';

import { IHelloWorldAdapter } from './types.js';

type BigNumberishLike =
  | bigint
  | number
  | string
  | {
      toNumber?: () => number;
      toBigInt?: () => bigint;
    };

const hasToNumber = (
  value: BigNumberishLike,
): value is { toNumber: () => number } =>
  !!value &&
  typeof value === 'object' &&
  'toNumber' in value &&
  typeof value.toNumber === 'function';

const toNumberValue = (value: BigNumberishLike): number => {
  if (typeof value === 'number') return value;
  if (hasToNumber(value)) return value.toNumber();
  return Number(toBigInt(value));
};

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
  ): Promise<EvmTransaction> {
    const contract = this.getConnectedContract();
    const toDomain = this.multiProvider.getDomainId(destination);
    const { transactionOverrides } = this.multiProvider.getChainMetadata(
      this.chainName,
    );

    const quote = await contract.quoteDispatch(toDomain, toBytes(message));
    const totalValue = BigInt(value) + toBigInt(quote);
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
        value: totalValue,
      },
    );

    const tx = {
      to: contract.address,
      data: contract.interface.encodeFunctionData('sendHelloWorld', [
        toDomain,
        message,
      ]),
      gasLimit: addBufferToGasLimit(estimated),
      ...transactionOverrides,
      value: totalValue,
    };
    return { transaction: tx, type: ProviderType.Evm };
  }

  async sentStat(destination: ChainName): Promise<number> {
    const destinationDomain = this.multiProvider.getDomainId(destination);
    const originContract = this.getConnectedContract();
    const sent = await originContract.sentTo(destinationDomain);
    return toNumberValue(sent);
  }

  override getConnectedContract() {
    return HelloWorld__factory.connect(
      this.addresses.router,
      this.getProvider(),
    );
  }
}
