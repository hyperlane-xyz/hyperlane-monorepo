import { toBytes } from 'viem';

import {
  ChainName,
  EthersV5Transaction,
  EvmRouterAdapter,
  MultiProtocolProvider,
  ProviderType,
} from '@hyperlane-xyz/sdk';
import { Address, addBufferToGasLimit } from '@hyperlane-xyz/utils';

import { HelloWorld__factory } from '../app/helloWorldFactory.js';

import { IHelloWorldAdapter } from './types.js';

type BigNumberishLike =
  | bigint
  | number
  | string
  | {
      toBigInt?: () => bigint;
      toNumber?: () => number;
      toString?: () => string;
    };

const toBigIntValue = (value: BigNumberishLike): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string') return BigInt(value);
  if (value?.toBigInt) return value.toBigInt();
  if (value?.toString) return BigInt(value.toString());

  throw new Error(`Cannot convert value to bigint: ${String(value)}`);
};

const toNumberValue = (value: BigNumberishLike): number => {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(BigInt(value));
  if (value?.toNumber) return value.toNumber();
  if (value?.toString) return Number(BigInt(value.toString()));

  throw new Error(`Cannot convert value to number: ${String(value)}`);
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
  ): Promise<EthersV5Transaction> {
    const contract = this.getConnectedContract();
    const toDomain = this.multiProvider.getDomainId(destination);
    const { transactionOverrides } = this.multiProvider.getChainMetadata(
      this.chainName,
    );

    const quote = await contract.callStatic.quoteDispatch(
      toDomain,
      toBytes(message),
    );
    const totalValue = BigInt(value) + toBigIntValue(quote);
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

    const tx = await contract.populateTransaction.sendHelloWorld(
      toDomain,
      message,
      {
        gasLimit: addBufferToGasLimit(estimated),
        ...transactionOverrides,
        value: totalValue,
      },
    );
    return { transaction: tx, type: ProviderType.EthersV5 };
  }

  async sentStat(destination: ChainName): Promise<number> {
    const destinationDomain = this.multiProvider.getDomainId(destination);
    const originContract = this.getConnectedContract();
    const sent = await originContract.sentTo(destinationDomain);
    return toNumberValue(sent);
  }

  override getConnectedContract(): any {
    return HelloWorld__factory.connect(
      this.addresses.router,
      this.getProvider(),
    ) as any;
  }
}
