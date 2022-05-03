import { BigNumber } from '@ethersproject/bignumber';

import { TypedEvent } from '@abacus-network/core/dist/commons';

import { Annotated } from '../events';

// copied from the Outbox.d.ts
export type DispatchTypes = [string, BigNumber, BigNumber, string, string];
export type DispatchArgs = {
  messageHash: string;
  leafIndex: BigNumber;
  destinationAndNonce: BigNumber;
  committedRoot: string;
  message: string;
};
export type DispatchEvent = TypedEvent<DispatchTypes & DispatchArgs>;

// copied from the Outbox.d.ts
export type CheckpointTypes = [string, BigNumber];
export type CheckpointArgs = { root: string; index: BigNumber };
export type CheckpointEvent = TypedEvent<CheckpointTypes & CheckpointArgs>;

// copied from the Inbox.d.ts
export type ProcessTypes = [string, boolean, string];
export type ProcessArgs = {
  messageHash: string;
  success: boolean;
  returnData: string;
};
export type ProcessEvent = TypedEvent<ProcessTypes & ProcessArgs>;

export type AbacusLifecyleEvent =
  | ProcessEvent
  | CheckpointEvent
  | DispatchEvent;

export type AnnotatedDispatch = Annotated<DispatchTypes, DispatchEvent>;
export type AnnotatedCheckpoint = Annotated<CheckpointTypes, CheckpointEvent>;
export type AnnotatedProcess = Annotated<ProcessTypes, ProcessEvent>;

export type AnnotatedLifecycleEvent =
  | AnnotatedDispatch
  | AnnotatedCheckpoint
  | AnnotatedProcess;
