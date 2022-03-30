import { arrayify, hexlify } from '@ethersproject/bytes';
// import { ethers } from 'ethers';
import { keccak256 } from 'ethers/lib/utils';

import { Inbox, Outbox } from '@abacus-network/core';

// import { NameOrDomain } from '../types';

import { AbacusCore } from '.';

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
export class UndispatchedAbacusMessage {
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
  // async estimateGas(
  //   src: NameOrDomain,
  //   dst: NameOrDomain,
  //   sender: string,
  //   recipient: string,
  //   message: string,
  // ) {
  //   // TODO come back to this
  //   const intrinsicGas = 21_000;
  //   const provingAndProcessingInboxCosts = 120_000;

  //   const provider = this.core.mustGetProvider(dst);
  //   const inbox = this.core.mustGetInbox(src, dst);

  //   const srcDomain = this.core.mustGetDomain(src);

  //   const handlerInterface = new ethers.utils.Interface([
  //     'function handle(uint32,bytes32,bytes)',
  //   ]);
  //   const directHandleEstimation = await provider.estimateGas({
  //     to: recipient,
  //     from: inbox.address,
  //     data: handlerInterface.encodeFunctionData('handle', [
  //       srcDomain.id,
  //       sender,
  //       message,
  //     ]),
  //   });

  //   console.log(
  //     'directHandleEstimation',
  //     directHandleEstimation,
  //     directHandleEstimation.toNumber(),
  //   );

  //   return directHandleEstimation
  //     .add(intrinsicGas)
  //     .add(provingAndProcessingInboxCosts);
  // }

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
