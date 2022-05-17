import { Result } from '@ethersproject/abi';
import { TransactionReceipt } from '@ethersproject/abstract-provider';

import {
  TypedEvent,
  TypedEventFilter,
} from '@abacus-network/core/dist/commons';

import { chainMetadata } from './chain-metadata';
import { MultiProvider } from './provider';
import { ChainName } from './types';

export class Annotated<U extends Result, T extends TypedEvent<U>> {
  readonly domain: number;
  readonly eventName?: string;
  readonly event: T;
  readonly receipt: TransactionReceipt;
  constructor(
    domain: number,
    receipt: TransactionReceipt,
    event: T,
    callerKnowsWhatTheyAreDoing = false,
  ) {
    if (!callerKnowsWhatTheyAreDoing) {
      throw new Error('Please instantiate using fromEvent or fromEvents');
    }

    this.domain = domain;
    this.receipt = receipt;
    this.eventName = event.eventSignature?.split('(')[0];
    this.event = event;
  }

  static async fromEvent<U extends Result, T extends TypedEvent<U>>(
    domain: number,
    event: T,
  ): Promise<Annotated<U, T>> {
    const receipt = await event.getTransactionReceipt();
    return new Annotated(domain, receipt, event, true);
  }

  static async fromEvents<U extends Result, T extends TypedEvent<U>>(
    domain: number,
    events: T[],
  ): Promise<Annotated<U, T>[]> {
    return Promise.all(
      events.map(async (event) => Annotated.fromEvent(domain, event)),
    );
  }

  get contractAddress(): string {
    // ok to use ! assertion here as we assume that the event is in the receipt
    const address = this.receipt.logs.find(
      (log) => log.logIndex === this.event.logIndex,
    )?.address;
    if (!address)
      throw new Error('Missing receipt. Class is in an inconsistent state');
    return address;
  }

  get transactionHash(): string {
    return this.receipt.transactionHash;
  }

  get blockNumber(): number {
    return this.receipt.blockNumber;
  }

  get blockHash(): string {
    return this.receipt.blockHash;
  }
}

// specifies an interface shared by the TS generated contracts
export interface TSContract<T extends Result, U> {
  queryFilter(
    event: TypedEventFilter<T, U>,
    fromBlockOrBlockhash?: number | undefined,
    toBlock?: number | undefined,
  ): Promise<Array<TypedEvent<T & U>>>;
}

export async function queryAnnotatedEvents<T extends Result, U>(
  multiprovider: MultiProvider<any>,
  network: ChainName,
  contract: TSContract<T, U>,
  filter: TypedEventFilter<T, U>,
  startBlock?: number,
  endBlock?: number,
): Promise<Array<Annotated<T, TypedEvent<T & U>>>> {
  const events = await getEvents(
    multiprovider,
    network,
    contract,
    filter,
    startBlock,
    endBlock,
  );
  return Annotated.fromEvents(chainMetadata[network].id, events);
}

export async function findAnnotatedSingleEvent<T extends Result, U>(
  multiprovider: MultiProvider<any>,
  network: ChainName,
  contract: TSContract<T, U>,
  filter: TypedEventFilter<T, U>,
  startBlock?: number,
): Promise<Array<Annotated<T, TypedEvent<T & U>>>> {
  const events = await findEvent(
    multiprovider,
    network,
    contract,
    filter,
    startBlock,
  );
  return Annotated.fromEvents(chainMetadata[network].id, events);
}

export async function getEvents<T extends Result, U>(
  multiprovider: MultiProvider<any>,
  network: ChainName,
  contract: TSContract<T, U>,
  filter: TypedEventFilter<T, U>,
  startBlock?: number,
  endBlock?: number,
): Promise<Array<TypedEvent<T & U>>> {
  const domain = chainMetadata[network];
  if (domain.paginate) {
    return getPaginatedEvents(
      multiprovider,
      network,
      contract,
      filter,
      startBlock,
      endBlock,
    );
  }
  return contract.queryFilter(filter, startBlock, endBlock);
}

export async function findEvent<T extends Result, U>(
  multiprovider: MultiProvider<any>,
  network: ChainName,
  contract: TSContract<T, U>,
  filter: TypedEventFilter<T, U>,
  startBlock?: number,
): Promise<Array<TypedEvent<T & U>>> {
  const domain = chainMetadata[network];
  if (domain.paginate) {
    return findFromPaginatedEvents(
      multiprovider,
      network,
      contract,
      filter,
      startBlock,
    );
  }
  return contract.queryFilter(filter, startBlock);
}

async function getPaginatedEvents<T extends Result, U>(
  multiprovider: MultiProvider<any>,
  network: ChainName,
  contract: TSContract<T, U>,
  filter: TypedEventFilter<T, U>,
  startBlock?: number,
  endBlock?: number,
): Promise<Array<TypedEvent<T & U>>> {
  const domain = chainMetadata[network];
  if (!domain.paginate) {
    throw new Error('Domain need not be paginated');
  }
  // get the first block by params
  // or domain deployment block
  const firstBlock = startBlock
    ? Math.max(startBlock, domain.paginate.from)
    : domain.paginate.from;
  // get the last block by params
  // or current block number
  let lastBlock;
  if (!endBlock) {
    const provider = multiprovider.getChainConnection(network).provider!;
    lastBlock = await provider.getBlockNumber();
  } else {
    lastBlock = endBlock;
  }
  // query domain pagination limit at a time, concurrently
  const eventArrayPromises = [];
  for (
    let from = firstBlock;
    from <= lastBlock;
    from += domain.paginate.blocks
  ) {
    const nextFrom = from + domain.paginate.blocks;
    const to = Math.min(nextFrom, lastBlock);
    const eventArrayPromise = contract.queryFilter(filter, from, to);
    eventArrayPromises.push(eventArrayPromise);
  }
  // await promises & concatenate results
  const eventArrays = await Promise.all(eventArrayPromises);
  let events: Array<TypedEvent<T & U>> = [];
  for (const eventArray of eventArrays) {
    events = events.concat(eventArray);
  }
  return events;
}

async function findFromPaginatedEvents<T extends Result, U>(
  multiprovider: MultiProvider<any>,
  network: ChainName,
  contract: TSContract<T, U>,
  filter: TypedEventFilter<T, U>,
  startBlock?: number,
  endBlock?: number,
): Promise<Array<TypedEvent<T & U>>> {
  const domain = chainMetadata[network];
  if (!domain.paginate) {
    throw new Error('Domain need not be paginated');
  }
  // get the first block by params
  // or domain deployment block
  const firstBlock = startBlock
    ? Math.max(startBlock, domain.paginate.from)
    : domain.paginate.from;
  // get the last block by params
  // or current block number
  let lastBlock;
  if (!endBlock) {
    const provider = multiprovider.getChainConnection(network).provider!;
    lastBlock = await provider.getBlockNumber();
  } else {
    lastBlock = endBlock;
  }
  // query domain pagination limit at a time, concurrently
  // eslint-disable-next-line for-direction
  for (let end = lastBlock; end > firstBlock; end -= domain.paginate.blocks) {
    const nextEnd = end - domain.paginate.blocks;
    const from = Math.max(nextEnd, firstBlock);
    const queriedEvents = await contract.queryFilter(filter, from, end);
    if (queriedEvents.length > 0) {
      return queriedEvents;
    }
  }
  return [];
}
