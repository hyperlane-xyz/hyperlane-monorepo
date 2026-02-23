import { toBytes } from 'viem';

import {
  ChainMap,
  ChainName,
  type HyperlaneCore as HyperlaneCoreType,
  HyperlaneContracts,
  HyperlaneContractsMap,
  HyperlaneCore,
  MultiProvider,
  RouterApp,
} from '@hyperlane-xyz/sdk';
import { Address, addBufferToGasLimit, rootLogger } from '@hyperlane-xyz/utils';

import { HelloWorldFactories } from './contracts.js';
import { StatCounts } from './types.js';

type SourceReceipt = Parameters<
  HyperlaneCoreType['waitForMessageProcessed']
>[0];

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

export class HelloWorldApp extends RouterApp<HelloWorldFactories> {
  constructor(
    public readonly core: HyperlaneCore,
    contractsMap: HyperlaneContractsMap<HelloWorldFactories>,
    multiProvider: MultiProvider,
    foreignDeployments: ChainMap<Address> = {},
  ) {
    super(
      contractsMap,
      multiProvider,
      rootLogger.child({ module: 'HelloWorldApp' }),
      foreignDeployments,
    );
  }

  router(contracts: HyperlaneContracts<HelloWorldFactories>): any {
    return contracts.router as any;
  }

  async sendHelloWorld(
    from: ChainName,
    to: ChainName,
    message: string,
    value: bigint,
  ): Promise<SourceReceipt> {
    const sender = this.getContracts(from).router;
    const toDomain = this.multiProvider.getDomainId(to);
    const { blocks, transactionOverrides } =
      this.multiProvider.getChainMetadata(from);

    // apply gas buffer due to https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/634
    const estimated = await sender.estimateGas.sendHelloWorld(
      toDomain,
      message,
      { ...transactionOverrides, value },
    );

    const quote = await sender.quoteDispatch(toDomain, toBytes(message));
    const totalValue = toBigIntValue(quote) + value;
    const tx = await sender.sendHelloWorld(toDomain, message, {
      gasLimit: addBufferToGasLimit(estimated),
      ...transactionOverrides,
      value: totalValue,
    });
    this.logger.info('Sending hello message', {
      from,
      to,
      message,
      tx,
    });
    return tx.wait(blocks?.confirmations ?? 1);
  }

  async waitForMessageReceipt(
    receipt: SourceReceipt,
  ): Promise<SourceReceipt[]> {
    return this.core.waitForMessageProcessing(receipt);
  }

  async waitForMessageProcessed(
    receipt: SourceReceipt,
  ): Promise<void> {
    return this.core.waitForMessageProcessed(receipt);
  }

  async channelStats(from: ChainName, to: ChainName): Promise<StatCounts> {
    const sent = await this.getContracts(from).router.sentTo(
      this.multiProvider.getDomainId(to),
    );
    const received = await this.getContracts(to).router.receivedFrom(
      this.multiProvider.getDomainId(from),
    );

    return {
      sent: toNumberValue(sent),
      received: toNumberValue(received),
    };
  }

  async stats(): Promise<ChainMap<ChainMap<StatCounts>>> {
    const entries: Array<[ChainName, ChainMap<StatCounts>]> = await Promise.all(
      this.chains().map(async (source) => {
        const remoteChains = await this.remoteChains(source);
        const destinationEntries = await Promise.all(
          remoteChains.map(async (destination) => [
            destination,
            await this.channelStats(source, destination),
          ]),
        );
        return [source, Object.fromEntries(destinationEntries)];
      }),
    );
    return Object.fromEntries(entries);
  }
}
