import { keccak256 } from 'ethers/lib/utils';

import { Inbox, Outbox } from '@abacus-network/core';
import { utils } from '@abacus-network/utils';

import { AbacusCore } from '..';
import { Address, ParsedMessage, parseMessage } from '../../utils';

/**
 * A deserialized Abacus message.
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
    this.outbox = core.mustGetContracts(this.message.origin).outbox;
    this.inbox = core.mustGetInbox(
      this.message.origin,
      this.message.destination,
    );
  }

  /**
   * The domain from which the message was sent.
   */
  get origin(): number {
    return this.message.origin;
  }

  /**
   * The identifier for the sender of this message
   */
  get sender(): string {
    return this.message.sender;
  }

  /**
   * The address of the sender of this message
   */
  get senderAddress(): Address {
    return utils.bytes32ToAddress(this.recipient);
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
   * The identifer for the recipient of this message
   */
  get recipient(): string {
    return this.message.recipient;
  }

  /**
   * The address of the recipient of this message
   */
  get recipientAddress(): Address {
    return utils.bytes32ToAddress(this.recipient);
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
