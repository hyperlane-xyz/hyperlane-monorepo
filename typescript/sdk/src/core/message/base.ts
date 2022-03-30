import { arrayify, hexlify } from '@ethersproject/bytes';
import { keccak256 } from 'ethers/lib/utils';

import { Inbox, Outbox } from '@abacus-network/core';

import { AbacusCore } from '..';

export type ParsedMessage = {
  from: number;
  sender: string;
  nonce: number;
  destination: number;
  recipient: string;
  body: string;
};

/**
 * Parse a serialized Abacus message from raw bytes.
 *
 * @param message
 * @returns
 */
export function parseMessage(message: string): ParsedMessage {
  const buf = Buffer.from(arrayify(message));
  const from = buf.readUInt32BE(0);
  const sender = hexlify(buf.slice(4, 36));
  const nonce = buf.readUInt32BE(36);
  const destination = buf.readUInt32BE(40);
  const recipient = hexlify(buf.slice(44, 76));
  const body = hexlify(buf.slice(76));
  return { from, sender, nonce, destination, recipient, body };
}

/**
 * An undispatched and deserialized Abacus message.
 */
export class BaseMessage {
  readonly message: ParsedMessage;
  readonly serializedMessage: string;

  readonly outbox: Outbox;
  readonly inbox: Inbox;

  readonly core: AbacusCore;

  constructor(core: AbacusCore, serializedMessage: string) {
    this.core = core;
    this.serializedMessage = serializedMessage;
    this.message = parseMessage(serializedMessage);
    this.outbox = core.mustGetContracts(this.message.from).outbox;
    this.inbox = core.mustGetInbox(this.message.from, this.message.destination);
  }

  /**
   * The domain from which the message was sent
   */
  get from(): number {
    return this.message.from;
  }

  /**
   * The domain from which the message was sent. Alias for `from`
   */
  get origin(): number {
    return this.from;
  }

  /**
   * The identifier for the sender of this message
   */
  get sender(): string {
    return this.message.sender;
  }

  /**
   * The domain nonce for this message
   */
  get nonce(): number {
    return this.message.nonce;
  }

  /**
   * The destination domain for this message
   */
  get destination(): number {
    return this.message.destination;
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
}
