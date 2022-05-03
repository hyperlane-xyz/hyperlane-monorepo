import { AbacusCore } from '.';
import { TransactionReceipt } from '@ethersproject/abstract-provider';
import { BigNumber } from '@ethersproject/bignumber';
import { arrayify, hexlify } from '@ethersproject/bytes';
import { keccak256 } from 'ethers/lib/utils';

import { Inbox, Outbox, Outbox__factory } from '@abacus-network/core';

import { Annotated, findAnnotatedSingleEvent } from '../events';
import { MultiProvider } from '../provider';
import {
  ChainName,
  ChainNameToDomainId,
  DomainIdToChainName,
  NameOrDomain,
} from '../types';
import { delay } from '../utils';

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
} from './events';

export type ParsedMessage = {
  origin: number;
  sender: string;
  destination: number;
  recipient: string;
  body: string;
};

export const resolveDomain = (nameOrDomain: NameOrDomain): ChainName =>
  typeof nameOrDomain === 'number'
    ? DomainIdToChainName[nameOrDomain]
    : nameOrDomain;

export const resolveId = (nameOrDomain: NameOrDomain): number =>
  typeof nameOrDomain === 'string'
    ? ChainNameToDomainId[nameOrDomain]
    : nameOrDomain;

export const resolveNetworks = (message: ParsedMessage) => {
  return {
    origin: resolveDomain(message.origin),
    destination: resolveDomain(message.destination),
  };
};

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
 * Parse a serialized Abacus message from raw bytes.
 *
 * @param message
 * @returns
 */
export function parseMessage(message: string): ParsedMessage {
  const buf = Buffer.from(arrayify(message));
  const origin = buf.readUInt32BE(0);
  const sender = hexlify(buf.slice(4, 36));
  const destination = buf.readUInt32BE(36);
  const recipient = hexlify(buf.slice(40, 72));
  const body = hexlify(buf.slice(72));
  return { origin, sender, destination, recipient, body };
}

// TODO: move AbacusMessage into AbacusCore app

/**
 * A deserialized Abacus message.
 */
export class AbacusMessage {
  readonly dispatch: AnnotatedDispatch;
  readonly message: ParsedMessage;
  readonly outbox: Outbox;
  readonly inbox: Inbox;

  readonly multiProvider: MultiProvider;
  readonly core: AbacusCore;
  protected cache: EventCache;

  constructor(
    multiProvider: MultiProvider,
    core: AbacusCore,
    dispatch: AnnotatedDispatch,
  ) {
    this.multiProvider = multiProvider;
    this.core = core;
    this.message = parseMessage(dispatch.event.args.message);
    this.dispatch = dispatch;

    const messageNetworks = resolveNetworks(this.message);
    const mailboxes = core.getMailboxPair(
      messageNetworks.origin as never, // TODO: Fix never type
      messageNetworks.destination,
    );

    this.outbox = mailboxes.outbox;
    this.inbox = mailboxes.inbox;
    this.cache = {};
  }

  /**
   * The receipt of the TX that dispatched this message
   */
  get receipt(): TransactionReceipt {
    return this.dispatch.receipt;
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
    multiProvider: MultiProvider,
    core: AbacusCore,
    nameOrDomain: NameOrDomain,
    receipt: TransactionReceipt,
  ): AbacusMessage[] {
    const messages: AbacusMessage[] = [];
    const outbox = new Outbox__factory().interface;
    const network = resolveDomain(nameOrDomain);
    const provider = multiProvider.getDomainConnection(network).provider!;

    for (const log of receipt.logs) {
      try {
        const parsed = outbox.parseLog(log);
        if (parsed.name === 'Dispatch') {
          const dispatch = {
            ...parsed,
            getBlock: () => provider.getBlock(log.blockHash),
            getTransaction: () => provider.getTransaction(log.transactionHash),
            getTransactionReceipt: () =>
              provider.getTransactionReceipt(log.transactionHash),
          } as unknown as DispatchEvent;

          const annotated = new Annotated<DispatchTypes, DispatchEvent>(
            resolveId(nameOrDomain),
            receipt,
            dispatch,
            true,
          );
          annotated.event.blockNumber = annotated.receipt.blockNumber;
          const message = new AbacusMessage(multiProvider, core, annotated);
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
    multiProvider: MultiProvider,
    core: AbacusCore,
    nameOrDomain: NameOrDomain,
    receipt: TransactionReceipt,
  ): AbacusMessage {
    const messages: AbacusMessage[] = AbacusMessage.fromReceipt(
      multiProvider,
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
    multiProvider: MultiProvider,
    core: AbacusCore,
    nameOrDomain: NameOrDomain,
    transactionHash: string,
  ): Promise<AbacusMessage[]> {
    const provider = multiProvider.getDomainConnection(
      resolveDomain(nameOrDomain),
    ).provider!;
    const receipt = await provider.getTransactionReceipt(transactionHash);
    if (!receipt) {
      throw new Error(`No receipt for ${transactionHash} on ${nameOrDomain}`);
    }
    return AbacusMessage.fromReceipt(
      multiProvider,
      core,
      nameOrDomain,
      receipt,
    );
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
    multiProvider: MultiProvider,
    core: AbacusCore,
    nameOrDomain: NameOrDomain,
    transactionHash: string,
  ): Promise<AbacusMessage> {
    const provider = multiProvider.getDomainConnection(
      resolveDomain(nameOrDomain),
    ).provider!;
    const receipt = await provider.getTransactionReceipt(transactionHash);
    if (!receipt) {
      throw new Error(`No receipt for ${transactionHash} on ${nameOrDomain}`);
    }
    return AbacusMessage.singleFromReceipt(
      multiProvider,
      core,
      nameOrDomain,
      receipt,
    );
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
        this.multiProvider,
        this.originName,
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
        this.multiProvider,
        this.destinationName,
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
    >(
      this.multiProvider,
      this.destinationName,
      this.inbox,
      processFilter,
      startBlock,
    );
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
   * WARNING: May never resolve. Oftern takes hours to resolve.
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
   * The domain from which the message was sent.
   */
  get origin(): number {
    return this.message.origin;
  }

  get originName(): ChainName {
    return resolveDomain(this.origin);
  }

  /**
   * The identifier for the sender of this message
   */
  get sender(): string {
    return this.message.sender;
  }

  /**
   * The destination domain for this message
   */
  get destination(): number {
    return this.message.destination;
  }

  get destinationName(): ChainName {
    return resolveDomain(this.destination);
  }

  /**
   * The identifer for the recipient for this message
   */
  get recipient(): string {
    return this.message.recipient;
  }

  /**
   * The message body
   */
  get body(): string {
    return this.message.body;
  }

  /**
   * The keccak256 hash of the message body
   */
  get bodyHash(): string {
    return keccak256(this.body);
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
}
