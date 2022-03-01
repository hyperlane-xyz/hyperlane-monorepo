import { BigNumber } from '@ethersproject/bignumber';
import { Result } from '@ethersproject/abi';
import { TransactionReceipt } from '@ethersproject/abstract-provider';

import { TypedEvent } from '@abacus-network/ts-interface/dist/abacus-core/commons';

// copied from the Home.d.ts
export type DispatchTypes = [string, BigNumber, BigNumber, string, string];
export type DispatchArgs = {
  messageHash: string;
  leafIndex: BigNumber;
  destinationAndNonce: BigNumber;
  committedRoot: string;
  message: string;
};
export type DispatchEvent = TypedEvent<DispatchTypes & DispatchArgs>;

// copied from the Home.d.ts
export type CheckpointTypes = [string, BigNumber];
export type CheckpointArgs =
      { root: string; index: BigNumber; };
export type CheckpointEvent = TypedEvent<CheckpointTypes & CheckpointArgs>;

// copied from the Replica.d.ts
export type ProcessTypes = [string, boolean, string];
export type ProcessArgs = {
  messageHash: string;
  success: boolean;
  returnData: string;
};
export type ProcessEvent = TypedEvent<ProcessTypes & ProcessArgs>;

export type AbacusLifecyleEvent = ProcessEvent | CheckpointEvent | DispatchEvent;

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

export type AnnotatedDispatch = Annotated<DispatchTypes, DispatchEvent>;
export type AnnotatedCheckpoint = Annotated<CheckpointTypes, CheckpointEvent>;
export type AnnotatedProcess = Annotated<ProcessTypes, ProcessEvent>;

export type AnnotatedLifecycleEvent =
  | AnnotatedDispatch
  | AnnotatedCheckpoint
  | AnnotatedProcess;
