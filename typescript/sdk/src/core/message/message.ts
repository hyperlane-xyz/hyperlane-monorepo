import { BigNumber } from '@ethersproject/bignumber';
import { TransactionReceipt } from '@ethersproject/abstract-provider';

import { Outbox__factory } from '@abacus-network/core';

import { Annotated, findAnnotatedSingleEvent } from '../../events';
import { NameOrDomain } from '../../types';
import { UndispatchedMessage } from './undispatched-message';
import { delay } from '../../utils';

import { AbacusCore } from '..';
import {
  AnnotatedCheckpoint,
  AnnotatedDispatch,
  AnnotatedLifecycleEvent,
  AnnotatedProcess,
  CheckpointArgs,
  CheckpointTypes,
  DispatchEvent,
  DispatchTypes,
  ProcessArgs,
  ProcessTypes,
} from '../events';

export type AbacusStatus = {
  status: MessageStatus;
  events: AnnotatedLifecycleEvent[];
};

export enum MessageStatus {
  Dispatched = 0,
  Included = 1,
  Relayed = 2,
  Processed = 3,
}

export enum InboxMessageStatus {
  None = 0,
  Proven,
  Processed,
}

export type EventCache = {
  outboxCheckpoint?: AnnotatedCheckpoint;
  inboxCheckpoint?: AnnotatedCheckpoint;
  process?: AnnotatedProcess;
};

/**
 * A dispatched Abacus message.
 */
export class AbacusMessage extends UndispatchedMessage {
  readonly dispatch: AnnotatedDispatch;

  protected cache: EventCache;

  constructor(core: AbacusCore, dispatch: AnnotatedDispatch) {
    super(core, dispatch.event.args.message);

    this.dispatch = dispatch;
    this.cache = {};
  }

  /**
   * Instantiate one or more messages from a receipt.
   *
   * @param core the {@link AbacusCore} object to use
   * @param nameOrDomain the domain on which the receipt was logged
   * @param receipt the receipt
   * @returns an array of {@link AbacusMessage} objects
   */
  static fromReceipt(
    core: AbacusCore,
    nameOrDomain: NameOrDomain,
    receipt: TransactionReceipt,
  ): AbacusMessage[] {
    const messages: AbacusMessage[] = [];
    const outbox = new Outbox__factory().interface;

    for (const log of receipt.logs) {
      try {
        const parsed = outbox.parseLog(log);
        if (parsed.name === 'Dispatch') {
          const dispatch = parsed as unknown as DispatchEvent;
          dispatch.getBlock = () => {
            return core.mustGetProvider(nameOrDomain).getBlock(log.blockHash);
          };
          dispatch.getTransaction = () => {
            return core
              .mustGetProvider(nameOrDomain)
              .getTransaction(log.transactionHash);
          };
          dispatch.getTransactionReceipt = () => {
            return core
              .mustGetProvider(nameOrDomain)
              .getTransactionReceipt(log.transactionHash);
          };

          const annotated = new Annotated<DispatchTypes, DispatchEvent>(
            core.resolveDomain(nameOrDomain),
            receipt,
            dispatch,
            true,
          );
          annotated.event.blockNumber = annotated.receipt.blockNumber;
          const message = new AbacusMessage(core, annotated);
          messages.push(message);
        }
      } catch (e) {
        continue;
      }
    }
    return messages;
  }

  /**
   * Instantiate EXACTLY one message from a receipt.
   *
   * @param core the {@link AbacusCore} object to use
   * @param nameOrDomain the domain on which the receipt was logged
   * @param receipt the receipt
   * @returns an array of {@link AbacusMessage} objects
   * @throws if there is not EXACTLY 1 dispatch in the receipt
   */
  static singleFromReceipt(
    core: AbacusCore,
    nameOrDomain: NameOrDomain,
    receipt: TransactionReceipt,
  ): AbacusMessage {
    const messages: AbacusMessage[] = AbacusMessage.fromReceipt(
      core,
      nameOrDomain,
      receipt,
    );
    if (messages.length !== 1) {
      throw new Error('Expected single Dispatch in transaction');
    }
    return messages[0];
  }

  /**
   * Instantiate one or more messages from a tx hash.
   *
   * @param core the {@link AbacusCore} object to use
   * @param nameOrDomain the domain on which the receipt was logged
   * @param receipt the receipt
   * @returns an array of {@link AbacusMessage} objects
   * @throws if there is no receipt for the TX
   */
  static async fromTransactionHash(
    core: AbacusCore,
    nameOrDomain: NameOrDomain,
    transactionHash: string,
  ): Promise<AbacusMessage[]> {
    const provider = core.mustGetProvider(nameOrDomain);
    const receipt = await provider.getTransactionReceipt(transactionHash);
    if (!receipt) {
      throw new Error(`No receipt for ${transactionHash} on ${nameOrDomain}`);
    }
    return AbacusMessage.fromReceipt(core, nameOrDomain, receipt);
  }

  /**
   * Instantiate EXACTLY one message from a transaction has.
   *
   * @param core the {@link AbacusCore} object to use
   * @param nameOrDomain the domain on which the receipt was logged
   * @param receipt the receipt
   * @returns an array of {@link AbacusMessage} objects
   * @throws if there is no receipt for the TX, or if not EXACTLY 1 dispatch in
   *         the receipt
   */
  static async singleFromTransactionHash(
    core: AbacusCore,
    nameOrDomain: NameOrDomain,
    transactionHash: string,
  ): Promise<AbacusMessage> {
    const provider = core.mustGetProvider(nameOrDomain);
    const receipt = await provider.getTransactionReceipt(transactionHash);
    if (!receipt) {
      throw new Error(`No receipt for ${transactionHash} on ${nameOrDomain}`);
    }
    return AbacusMessage.singleFromReceipt(core, nameOrDomain, receipt);
  }

  /**
   * Get the Outbox `Checkpoint` event associated with this message (if any)
   *
   * @returns An {@link AnnotatedCheckpoint} (if any)
   */
  async getOutboxCheckpoint(): Promise<AnnotatedCheckpoint | undefined> {
    // if we have already gotten the event,
    // return it without re-querying
    if (this.cache.outboxCheckpoint) {
      return this.cache.outboxCheckpoint;
    }

    const leafIndex = this.dispatch.event.args.leafIndex;
    const [checkpointRoot, checkpointIndex] =
      await this.outbox.latestCheckpoint();
    // The checkpoint index needs to be at least leafIndex + 1 to include
    // the message.
    if (checkpointIndex.lte(leafIndex)) {
      return undefined;
    }

    // Query the latest checkpoint event.
    const checkpointFilter = this.outbox.filters.Checkpoint(
      checkpointRoot,
      checkpointIndex,
    );

    const checkpointLogs: AnnotatedCheckpoint[] =
      await findAnnotatedSingleEvent<CheckpointTypes, CheckpointArgs>(
        this.core,
        this.origin,
        this.outbox,
        checkpointFilter,
      );

    if (checkpointLogs.length === 1) {
      // if event is returned, store it to the object
      this.cache.outboxCheckpoint = checkpointLogs[0];
    } else if (checkpointLogs.length > 1) {
      throw new Error('multiple outbox checkpoints for same root and index');
    }
    // return the event or undefined if it doesn't exist
    return this.cache.outboxCheckpoint;
  }

  /**
   * Get the Inbox `Checkpoint` event associated with this message (if any)
   *
   * @returns An {@link AnnotatedCheckpoint} (if any)
   */
  async getInboxCheckpoint(): Promise<AnnotatedCheckpoint | undefined> {
    // if we have already gotten the event,
    // return it without re-querying
    if (this.cache.inboxCheckpoint) {
      return this.cache.inboxCheckpoint;
    }

    const leafIndex = this.dispatch.event.args.leafIndex;
    const [checkpointRoot, checkpointIndex] =
      await this.inbox.latestCheckpoint();
    // The checkpoint index needs to be at least leafIndex + 1 to include
    // the message.
    if (checkpointIndex.lte(leafIndex)) {
      return undefined;
    }

    // if not, attempt to query the event
    const checkpointFilter = this.inbox.filters.Checkpoint(
      checkpointRoot,
      checkpointIndex,
    );
    const checkpointLogs: AnnotatedCheckpoint[] =
      await findAnnotatedSingleEvent<CheckpointTypes, CheckpointArgs>(
        this.core,
        this.destination,
        this.inbox,
        checkpointFilter,
      );
    if (checkpointLogs.length === 1) {
      // if event is returned, store it to the object
      this.cache.inboxCheckpoint = checkpointLogs[0];
    } else if (checkpointLogs.length > 1) {
      throw new Error('multiple inbox checkpoints for same root');
    }
    // return the event or undefined if it wasn't found
    return this.cache.inboxCheckpoint;
  }

  /**
   * Get the Inbox `Process` event associated with this message (if any)
   *
   * @returns An {@link AnnotatedProcess} (if any)
   */
  async getProcess(startBlock?: number): Promise<AnnotatedProcess | undefined> {
    // if we have already gotten the event,
    // return it without re-querying
    if (this.cache.process) {
      return this.cache.process;
    }
    // if not, attempt to query the event
    const processFilter = this.inbox.filters.Process(this.leaf);
    const processLogs = await findAnnotatedSingleEvent<
      ProcessTypes,
      ProcessArgs
    >(this.core, this.destination, this.inbox, processFilter, startBlock);
    if (processLogs.length === 1) {
      // if event is returned, store it to the object
      this.cache.process = processLogs[0];
    } else if (processLogs.length > 1) {
      throw new Error('multiple inbox process for same message');
    }
    // return the process or undefined if it doesn't exist
    return this.cache.process;
  }

  /**
   * Get all lifecycle events associated with this message
   *
   * @returns An array of {@link AnnotatedLifecycleEvent} objects
   */
  async events(): Promise<AbacusStatus> {
    const events: AnnotatedLifecycleEvent[] = [this.dispatch];
    // attempt to get Outbox checkpoint
    const outboxCheckpoint = await this.getOutboxCheckpoint();
    if (!outboxCheckpoint) {
      return {
        status: MessageStatus.Dispatched, // the message has been sent; nothing more
        events,
      };
    }
    events.push(outboxCheckpoint);
    // attempt to get Inbox checkpoint
    const inboxCheckpoint = await this.getInboxCheckpoint();
    if (!inboxCheckpoint) {
      return {
        status: MessageStatus.Included, // the message was sent, then included in an Checkpoint on Outbox
        events,
      };
    }
    events.push(inboxCheckpoint);
    // attempt to get Inbox process
    const process = await this.getProcess(inboxCheckpoint.blockNumber);
    if (!process) {
      // NOTE: when this is the status, you may way to
      // query confirmAt() to check if challenge period
      // on the Inbox has elapsed or not
      return {
        status: MessageStatus.Relayed, // the message was sent, included in an Checkpoint, then relayed to the Inbox
        events,
      };
    }
    events.push(process);
    return {
      status: MessageStatus.Processed, // the message was processed
      events,
    };
  }

  /**
   * Retrieve the inbox status of this message.
   *
   * @returns The {@link InboxMessageStatus} corresponding to the solidity
   * status of the message.
   */
  async inboxStatus(): Promise<InboxMessageStatus> {
    return this.inbox.messages(this.leaf);
  }

  /**
   * Checks whether the message has been delivered.
   *
   * @returns true if processed, else false.
   */
  async delivered(): Promise<boolean> {
    const status = await this.inboxStatus();
    return status === InboxMessageStatus.Processed;
  }

  /**
   * Returns a promise that resolves when the message has been delivered.
   *
   * @param opts Polling options.
   */
  async wait(opts?: { pollTime?: number }): Promise<void> {
    const interval = opts?.pollTime ?? 5000;

    // sad spider face
    for (;;) {
      if (await this.delivered()) {
        return;
      }
      await delay(interval);
    }
  }

  /**
   * The receipt of the TX that dispatched this message
   */
  get receipt(): TransactionReceipt {
    return this.dispatch.receipt;
  }

  /**
   * The hash of the transaction that dispatched this message
   */
  get transactionHash(): string {
    return this.dispatch.event.transactionHash;
  }

  /**
   * The messageHash committed to the tree in the Outbox contract.
   */
  get leaf(): string {
    return this.dispatch.event.args.messageHash;
  }

  /**
   * The index of the leaf in the contract.
   */
  get leafIndex(): BigNumber {
    return this.dispatch.event.args.leafIndex;
  }

  /**
   * The destination and nonceof this message.
   */
  get destinationAndNonce(): BigNumber {
    return this.dispatch.event.args.destinationAndNonce;
  }

  /**
   * The committed root when this message was dispatched.
   */
  get committedRoot(): string {
    return this.dispatch.event.args.committedRoot;
  }

  // /**
  //  * Estimates the amount of gas required to process a message.
  //  * This does not assume the Inbox of the domain the message will be processed on has
  //  * a checkpoint that the message is included in. Therefore, we estimate
  //  * the gas by summing:
  //  * 1. The intrinsic gas cost of a transaction on the destination chain.
  //  * 2. Any gas costs imposed by operations in the Inbox, including proving
  //  *    the message and logic surrounding the processing of a message.
  //  * 3. Estimating the gas consumption of a direct call to the `handle`
  //  *    function of the recipient address using the correct parameters and
  //  *    setting the `from` address of the transaction to the address of the inbox.
  //  * 4. A buffer to account for inaccuracies in the above estimations.
  //  */
  // async estimateGas() {
  //   // TODO come back to this
  //   const intrinsicGas = 21_000;
  //   const provingAndProcessingInboxCosts = 120_000;

  //   const connection = this.core.mustGetConnection(this.destination);

  //   const handlerInterface = new ethers.utils.Interface(
  //     ['function handle(uint32,bytes32,bytes)']
  //   );
  //   const directHandleEstimation = await connection.estimateGas({
  //     to: this.recipient,
  //     from: this.inbox.address,
  //     data: handlerInterface.encodeFunctionData('handle', [
  //       this.origin,
  //       this.sender,
  //       this.message,
  //     ])
  //   });

  //   console.log('directHandleEstimation', directHandleEstimation, directHandleEstimation.toNumber());

  //   return directHandleEstimation
  //     .add(intrinsicGas)
  //     .add(provingAndProcessingInboxCosts);
  // }
}
