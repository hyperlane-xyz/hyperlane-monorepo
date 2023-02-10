import { providers } from 'ethers';

import type {
  TypedEvent,
  TypedEventFilter,
} from '@hyperlane-xyz/core/dist/common';

// import { chainMetadata } from './consts/chainMetadata';
import { MultiProvider } from './providers/MultiProvider';
import { ChainName } from './types';

export class Annotated<T extends TypedEvent> {
  readonly domain: number;
  readonly eventName?: string;
  readonly event: T;
  readonly receipt: providers.TransactionReceipt;
  constructor(
    domain: number,
    receipt: providers.TransactionReceipt,
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

  static async fromEvent<T extends TypedEvent>(
    domain: number,
    event: T,
  ): Promise<Annotated<T>> {
    const receipt = await event.getTransactionReceipt();
    return new Annotated(domain, receipt, event, true);
  }

  static async fromEvents<T extends TypedEvent>(
    domain: number,
    events: T[],
  ): Promise<Annotated<T>[]> {
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
export interface TSContract<T extends TypedEvent> {
  queryFilter(
    event: TypedEventFilter<T>,
    fromBlockOrBlockhash?: number | undefined,
    toBlock?: number | undefined,
  ): Promise<Array<T>>;
}

export async function queryAnnotatedEvents<T extends TypedEvent>(
  multiprovider: MultiProvider,
  chain: ChainName,
  contract: TSContract<T>,
  filter: TypedEventFilter<T>,
  startBlock?: number,
  endBlock?: number,
): Promise<Array<Annotated<T>>> {
  const events = await getEvents(
    multiprovider,
    chain,
    contract,
    filter,
    startBlock,
    endBlock,
  );
  return Annotated.fromEvents(multiprovider.getChainId(chain), events);
}

export async function findAnnotatedSingleEvent<T extends TypedEvent>(
  multiprovider: MultiProvider,
  chain: ChainName,
  contract: TSContract<T>,
  filter: TypedEventFilter<T>,
  startBlock?: number,
): Promise<Array<Annotated<T>>> {
  const events = await findEvent(
    multiprovider,
    chain,
    contract,
    filter,
    startBlock,
  );
  return Annotated.fromEvents(multiprovider.getChainId(chain), events);
}

export async function getEvents<T extends TypedEvent>(
  multiprovider: MultiProvider,
  chain: ChainName,
  contract: TSContract<T>,
  filter: TypedEventFilter<T>,
  startBlock?: number,
  endBlock?: number,
): Promise<Array<T>> {
  const metadata = multiprovider.getChainMetadata(chain);
  const mustPaginate = !!metadata.publicRpcUrls[0].pagination;
  if (mustPaginate) {
    return getPaginatedEvents(
      multiprovider,
      chain,
      contract,
      filter,
      startBlock,
      endBlock,
    );
  }
  return contract.queryFilter(filter, startBlock, endBlock);
}

export async function findEvent<T extends TypedEvent>(
  multiprovider: MultiProvider,
  chain: ChainName,
  contract: TSContract<T>,
  filter: TypedEventFilter<T>,
  startBlock?: number,
): Promise<Array<T>> {
  const metadata = multiprovider.getChainMetadata(chain);
  const mustPaginate = !!metadata.publicRpcUrls[0].pagination;
  if (mustPaginate) {
    return findFromPaginatedEvents(
      multiprovider,
      chain,
      contract,
      filter,
      startBlock,
    );
  }
  return contract.queryFilter(filter, startBlock);
}

async function getPaginatedEvents<T extends TypedEvent>(
  multiprovider: MultiProvider,
  chain: ChainName,
  contract: TSContract<T>,
  filter: TypedEventFilter<T>,
  startBlock?: number,
  endBlock?: number,
): Promise<Array<T>> {
  const metadata = multiprovider.getChainMetadata(chain);
  const pagination = metadata.publicRpcUrls[0].pagination;
  if (!pagination) {
    throw new Error('Domain need not be paginated');
  }
  // get the first block by params
  // or domain deployment block
  const firstBlock = startBlock
    ? Math.max(startBlock, pagination.from)
    : pagination.from;
  // get the last block by params
  // or current block number
  let lastBlock;
  if (!endBlock) {
    const provider = multiprovider.getProvider(chain);
    lastBlock = await provider.getBlockNumber();
  } else {
    lastBlock = endBlock;
  }
  // query domain pagination limit at a time, concurrently
  const eventArrayPromises = [];
  for (let from = firstBlock; from <= lastBlock; from += pagination.blocks) {
    const nextFrom = from + pagination.blocks;
    const to = Math.min(nextFrom, lastBlock);
    const eventArrayPromise = contract.queryFilter(filter, from, to);
    eventArrayPromises.push(eventArrayPromise);
  }
  // await promises & concatenate results
  const eventArrays = await Promise.all(eventArrayPromises);
  let events: Array<T> = [];
  for (const eventArray of eventArrays) {
    events = events.concat(eventArray);
  }
  return events;
}

async function findFromPaginatedEvents<T extends TypedEvent>(
  multiprovider: MultiProvider,
  chain: ChainName,
  contract: TSContract<T>,
  filter: TypedEventFilter<T>,
  startBlock?: number,
  endBlock?: number,
): Promise<Array<T>> {
  const metadata = multiprovider.getChainMetadata(chain);
  const pagination = metadata.publicRpcUrls[0].pagination;
  if (!pagination) {
    throw new Error('Domain need not be paginated');
  }
  // get the first block by params
  // or domain deployment block
  const firstBlock = startBlock
    ? Math.max(startBlock, pagination.from)
    : pagination.from;
  // get the last block by params
  // or current block number
  let lastBlock;
  if (!endBlock) {
    const provider = multiprovider.getProvider(chain);
    lastBlock = await provider.getBlockNumber();
  } else {
    lastBlock = endBlock;
  }
  // query domain pagination limit at a time, concurrently
  // eslint-disable-next-line for-direction
  for (let end = lastBlock; end > firstBlock; end -= pagination.blocks) {
    const nextEnd = end - pagination.blocks;
    const from = Math.max(nextEnd, firstBlock);
    const queriedEvents = await contract.queryFilter(filter, from, end);
    if (queriedEvents.length > 0) {
      return queriedEvents;
    }
  }
  return [];
}
